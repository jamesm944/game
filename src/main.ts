/**
 * Browser entry — M1-T7 game loop + M1-T8 command UI.
 *
 * Fixed-timestep accumulator per SPEC §2.1: requestAnimationFrame feeds
 * a wall-clock delta (clamped to 250 ms against tab-switch/GC spikes),
 * which drains in whole 30 Hz ticks up to a max-steps cap; leftover
 * fraction becomes the interpolation alpha. After stepping, the pure
 * sim snapshot producer copies unit state into the double-buffered
 * mirror, the renderer samples it, and three.js draws. Render never
 * touches component rows directly — seam per ADR-0001.
 *
 * M1-T7: Pops render through the instanced billboard-atlas layer (one
 * draw call for all villagers; playback + billboarding live entirely in
 * the vertex shader). The loop asserts the §7 draw-call budget via
 * renderer.info each frame.
 *
 * M1-T8: the prototype-validated command layer (§2.13) wires in here —
 * ground-plane picking over sim coordinates, right-click groupMove
 * orders into the sim inbox with same-frame green-ring feedback,
 * control groups, minimap camera jumps, orders log, tick/fps topbar.
 *
 * M2-T6: overlays complete SPEC §7's two-extra-draw-call contract —
 * instanced health bars join the selection rings (exactly 2 overlay
 * calls total; see docs/m2-overlays.md for the browser-only
 * renderer.info dev check). Attack-move (A) and stop (S) keyboard
 * orders enter the same sim inbox as clicks.
 *
 * M2-T10: game flow — the skirmish bootstrap moved into game/session.ts
 * so restart builds a FRESH world from a new seed through the SAME code
 * path as boot; the §2.11 victory evaluator decides conquest matches,
 * the HUD shows the victory/defeat overlay with a death-ledger stats
 * recap, and the surrender control concedes through the shared inbox.
 */

import "./style.css";
import {
  Color,
  DirectionalLight,
  HemisphereLight,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  WebGLRenderer,
  type DataTexture,
} from "three";
import atlasUrl from "./assets/atlas/villager.png";
import atlasIndexJson from "./assets/atlas/villager.frames.json";
import { createRingMarkerPool } from "./render/ringMarkers";
import {
  SELECTION_RING_CAPACITY,
  createSelectionRings,
} from "./render/selectionRings";
import {
  getAssignedSite,
  getBuildingRow,
  getBuildingSiteRow,
  populationCapOf,
  populationOf,
  readTrainQueue,
} from "./sim/components";
import {
  buildingDefOf,
  buildingIdOfCode,
  BUILDING_DEFINITIONS,
  recipeDefOf,
  recipeIdOfCode,
  recipesForBuilding,
  unitDefOf,
  unitIdOfCode,
} from "./data/definitions";
import {
  PLAYER_ONE,
  ledgerAmountOfSlug,
  stockpileSnapshot,
} from "./sim/core/stockpile";
import { TICK_DT_MS, step } from "./sim/core/world";
import { canEnqueueTraining } from "./sim/systems/training";
import { currentAgeRankOf, isDefAgeUnlocked } from "./sim/systems/age";
import { canAfford, validatePlacement } from "./sim/systems/placement";
import { WORK_MILLI_SCALE } from "./sim/systems/construction";
import {
  captureBuildingSnapshot,
  captureSimSnapshot,
  type SimSnapshotFrame,
} from "./sim/mirror";
import { createWorkerTransport } from "./sim/path/scheduler";
import { getProductionCycleRow } from "./sim/components/production";
import { createPathWorkerFactory } from "./game/paths";
import {
  consumeNextSeed,
  createSkirmishWorld,
  freshSeed,
  stashNextSeed,
} from "./game/session";
import {
  SURRENDER_COMMAND_KIND,
  evaluateOutcome,
  unitsLostOf,
} from "./sim/systems/victory";
import {
  managementCandidatesOf,
  managementRatingOf,
  managerOfDomain,
} from "./sim/systems/management";
import {
  DOMAIN_NAMES,
  domainOfBuildingDef,
  foremanRowOf,
  strategyWeightsOf,
} from "./sim/components/management";
import { RtsCamera } from "./render/camera";
import { createBuildingLayer } from "./render/buildings";
import {
  copyFogTexture,
  createFogShaderUniforms,
  writeFogPlaneIntoTexture,
} from "./render/fogTexture";
import { createBuildGhost } from "./render/buildGhost";
import {
  createRenderMirror,
  pushFrame,
  sampleMirror,
  type MirrorSampleOut,
} from "./render/mirror";
import { buildTerrainMesh, terrainHeightAt } from "./render/terrain";
import { createUnitSpriteLayer } from "./render/unitSprites";
import { createHealthBars } from "./render/healthBars";
import {
  HEALTH_BAR_CAPACITY,
  packHealthBarAttributes,
  type HealthBarAttributeArrays,
} from "./render/overlayPack";
import { issueAttackMove, issueStop } from "./ui/orders";
import {
  issuePlaceBuilding,
  snapGhostOrigin,
  wireBuildMenu,
} from "./ui/buildMenu";
import { createBuildingPanel } from "./ui/buildingPanel";
import { createDomainPanel, type DomainPanelData } from "./ui/domainPanel";
import { popNameOf } from "./sim/components/pop";
import { createPopCard } from "./ui/popCard";
import { buildPopCard } from "./sim/popCard";
import { wireControlGroups } from "./ui/controlGroups";
import { createTopbar, formatStockpileLine } from "./ui/hud";
import { createToastHost } from "./ui/toast";
import { MINIMAP_REDRAW_MS, createMinimap } from "./ui/minimap";
import { wireOrderInput } from "./ui/orders";
import {
  getSelectedEids,
  isSelected,
  noteLiveEids,
  selectionCount,
  setSelection,
  wireSelectionInput,
} from "./ui/selection";
import {
  createSurrenderControl,
  createVictoryScreen,
} from "./ui/victoryScreen";
import { buildingRectOf, siteRectOf } from "./sim/components/buildings";

/** Fixed development seed — reproducible map for the render skeleton. */
const DEV_SEED = 20260822;
/**
 * Restart handoff: a stashed seed (set by the victory overlay's Restart
 * button) boots the NEXT fresh world through the same session
 * bootstrap; absent one, the dev seed replays the familiar map.
 */
const bootSeed = consumeNextSeed(window.localStorage) ?? DEV_SEED;
/**
 * Mirror/overlay sample capacity: sized past the dev start population
 * so M2-T6 trained armies render without re-allocating the frame loop's
 * scratch arrays.
 */
const RENDER_CAPACITY = 128;
/** SPEC §7 loop safety: clamp + max-steps-per-frame cap. */
const FRAME_CLAMP_MS = 250;
const MAX_STEPS_PER_FRAME = 5;
/** Billboard world size: ~1.5 tiles tall so units read at map zoom. */
const SPRITE_WORLD_WIDTH = 0.95;
const SPRITE_WORLD_HEIGHT = 1.5;

// ---- World (the shared skirmish bootstrap — identical to tests) -------------

const session = createSkirmishWorld(bootSeed, {
  createTransport: () => createWorkerTransport(createPathWorkerFactory()),
});
const { world, comps, fog } = session;

// ---- Renderer ---------------------------------------------------------------

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // §7 budget
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(0x10141c);

const hemisphereLight = new HemisphereLight(0xcfd8e8, 0x3a4436, 1.05);
scene.add(hemisphereLight);
const sun = new DirectionalLight(0xfff2d9, 1.35);
sun.position.set(0.55, 1, 0.35);
scene.add(sun);

// M3-T6 day/night lighting (render-only): the mirror sample's tint
// scales the fixed rig every frame — background color and both light
// intensities ride the §2.4 sim clock.
const baseBackground = new Color(0x10141c);
const scratchBackground = new Color();
const BASE_SUN_INTENSITY = 1.35;
const BASE_HEMI_INTENSITY = 1.05;

// Fog DataTexture pair (SPEC §2.9): R=explored G=visible planes for the
// human viewer, blended uFogPrev → uFogCurr across each tick interval.
const VIEWER = PLAYER_ONE;
const fogUniforms = createFogShaderUniforms(fog.state, VIEWER);
let fogRevision = fog.revision;

const terrain = buildTerrainMesh(world.layers, fogUniforms);
scene.add(terrain);

const cameraRig = new RtsCamera({ mapSize: world.layers.size });
cameraRig.resize(window.innerWidth, window.innerHeight);
cameraRig.setCenter(world.layers.size / 2, world.layers.size / 2);

// Mirror plumbing: reusable capture staging + allocation-free sampling.
let staging: SimSnapshotFrame | undefined;
const sampleOut: MirrorSampleOut = {
  positions: new Float32Array(RENDER_CAPACITY * 2),
  headings: new Float32Array(RENDER_CAPACITY),
  hpFractions: new Float32Array(RENDER_CAPACITY),
  lightTint: new Float32Array(3),
};
const groundHeights = new Float32Array(RENDER_CAPACITY);
/** 1 = selected, per mirror rank — forces health bars on. */
const selectedFlags = new Uint8Array(RENDER_CAPACITY);
const mirror = createRenderMirror();

// Fog CPU-culling scratch (SPEC §2.9): entities culled against the
// visible plane BEFORE instancing; health-bar fractions ride the full
// mirror ranks with invisible units forced to "undamaged" so no bar
// floats over a hidden enemy.
const viewerKnowledge = fog.knowledgeFor(VIEWER);
const culledPositions = new Float32Array(RENDER_CAPACITY * 2);
const culledHeadings = new Float32Array(RENDER_CAPACITY);
const barHpFractions = new Float32Array(RENDER_CAPACITY);
/** Building feed cap mirrors the instanced layer's MAX_BUILDINGS. */
const BUILDING_RENDER_CAP = 128;
const bOrigins = new Float32Array(BUILDING_RENDER_CAP * 2);
const bSizes = new Float32Array(BUILDING_RENDER_CAP * 2);
const bStates = new Uint8Array(BUILDING_RENDER_CAP);
const bProgress = new Float32Array(BUILDING_RENDER_CAP);
const bEids = new Int32Array(BUILDING_RENDER_CAP);
const bGhosts = new Uint8Array(BUILDING_RENDER_CAP);

async function loadVillagerLayer(): Promise<
  ReturnType<typeof createUnitSpriteLayer>
> {
  const texture = await new TextureLoader().loadAsync(atlasUrl);
  texture.colorSpace = SRGBColorSpace; // bake colors are sRGB PNG bytes
  return createUnitSpriteLayer({
    atlasTexture: texture,
    indexJson: atlasIndexJson,
    action: "walk",
    maxInstances: RENDER_CAPACITY,
    worldWidth: SPRITE_WORLD_WIDTH,
    worldHeight: SPRITE_WORLD_HEIGHT,
  });
}

function writePopInstances(
  layer: ReturnType<typeof createUnitSpriteLayer>,
  positions: Float32Array,
  headings: Float32Array,
  sampledCount: number,
): void {
  for (let i = 0; i < sampledCount && i < RENDER_CAPACITY; i++) {
    groundHeights[i] = terrainHeightAt(
      world.layers,
      positions[i * 2]!,
      positions[i * 2 + 1]!,
    );
  }
  layer.writeInstances(
    {
      positions,
      headings,
      count: sampledCount,
    },
    groundHeights,
    cameraRig.azimuthRad,
    1,
    1,
    1,
  );
}

// ---- Command UI (M1-T8) -----------------------------------------------------

const canvas = renderer.domElement;
canvas.id = "game";

const groundAt = (
  clientX: number,
  clientY: number,
): { x: number; y: number } | null => {
  const hit = cameraRig.groundPointAt(clientX, clientY);
  return hit ? { x: hit.x, y: hit.z } : null;
};

const worldPerPixel = (): number =>
  cameraRig.viewHeight / Math.max(window.innerHeight, 1);

/** Exact on-screen test for double-click select-same-type (§2.13). */
const ndcScratch = new Vector3();
const isOnScreen = (x: number, y: number): boolean => {
  ndcScratch
    .set(x, terrainHeightAt(world.layers, x, y), y)
    .project(cameraRig.camera);
  return (
    Math.abs(ndcScratch.x) <= 1 &&
    Math.abs(ndcScratch.y) <= 1 &&
    ndcScratch.z <= 1
  );
};

/** Building/site entity whose footprint covers a world point. */
const buildingAt = (x: number, y: number): number | undefined => {
  for (let i = world.entities.length - 1; i >= 0; i--) {
    const eid = world.entities[i]!;
    const rect =
      siteRectOf(world, comps, eid) ?? buildingRectOf(world, comps, eid);
    if (!rect) continue;
    if (
      x >= rect.x &&
      x < rect.x + rect.width &&
      y >= rect.y &&
      y < rect.y + rect.height
    ) {
      return eid;
    }
  }
  return undefined;
};

wireSelectionInput({
  canvas,
  groundPointAt: groundAt,
  getFrame: () => staging ?? null,
  worldPerPixel,
  isOnScreen,
  buildingAt,
});

// Green ring feedback pool + orders log; the marker spawns synchronously
// inside the right-click handler → visible the same rendered frame.
const moveMarkers = createRingMarkerPool({ scene, layers: world.layers });

/** Resource-node entity under a world point, for contextual gather orders. */
const nodeAt = (x: number, y: number): number | undefined => {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 0 || ty < 0 || tx >= world.layers.size || ty >= world.layers.size) {
    return undefined;
  }
  const nodeRows = world.rowsByComponentId.get(comps.resourceNodeId);
  if (!nodeRows) return undefined;
  for (const [eid, row] of nodeRows) {
    if ((row[1] ?? 0) <= 0) continue; // depleted nodes are not targets
    const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
    if (!pos) continue;
    if (Math.floor(pos[0]!) === tx && Math.floor(pos[1]!) === ty) return eid;
  }
  return undefined;
};

// ---- Build menu + ghost placement (M1-T10, §2.13) ---------------------------

const buildGhost = createBuildGhost();
scene.add(buildGhost.mesh);

const buildMenu = wireBuildMenu({
  canAfford: (defId) => canAfford(world, comps, PLAYER_ONE, defId),
  ageUnlocked: (defId) => {
    const def = BUILDING_DEFINITIONS.get(defId);
    return (
      def !== undefined &&
      isDefAgeUnlocked(world, comps, PLAYER_ONE, def.ageGate)
    );
  },
  onArm: () => {},
});

/** Last pointer position in client pixels for the armed ghost. */
let lastPointerClientX = -1;
let lastPointerClientY = -1;
canvas.addEventListener("pointermove", (event: PointerEvent) => {
  lastPointerClientX = event.clientX;
  lastPointerClientY = event.clientY;
});

/**
 * Current ghost candidate under the pointer while a def is armed, or
 * null. Shared by the per-frame repaint AND click-to-place so both see
 * the exact same validity verdict.
 */
function currentPlacementCheck(): {
  defId: string;
  tileX: number;
  tileY: number;
  ok: boolean;
  reason?: string | undefined;
} | null {
  const defId = buildMenu.armedDefId();
  if (!defId || lastPointerClientX < 0) return null;
  const ground = cameraRig.groundPointAt(
    lastPointerClientX,
    lastPointerClientY,
  );
  if (!ground) return null;
  const def = BUILDING_DEFINITIONS.get(defId);
  if (!def) return null;
  const origin = snapGhostOrigin(
    ground.x,
    ground.z,
    def.footprint.width,
    def.footprint.height,
  );
  const check = validatePlacement(
    world,
    comps,
    defId,
    origin.tileX,
    origin.tileY,
  );
  return {
    defId,
    tileX: origin.tileX,
    tileY: origin.tileY,
    ok: check.ok,
    reason: check.reason,
  };
}

// Polite same-frame refusal feedback (SPEC §2.13): a click the sim
// would reject for age shows why, right now.
const toast = createToastHost();

canvas.addEventListener("click", (event: MouseEvent) => {
  if (event.button !== 0) return;
  // Armed attack-move (A): the click becomes an attackMove order at
  // that ground point instead of a placement/selection click.
  if (attackMoveArmed) {
    attackMoveArmed = false;
    const ground = groundAt(event.clientX, event.clientY);
    if (ground && selectionCount() > 0) {
      issueAttackMove(
        world.inbox,
        world.tick,
        getSelectedEids(),
        ground.x,
        ground.y,
      );
      moveMarkers.spawn(ground.x, ground.y); // same-frame feedback
    }
    return;
  }
  const candidate = currentPlacementCheck();
  if (!candidate || !candidate.ok) {
    if (candidate?.reason === "age-gated") {
      const def = BUILDING_DEFINITIONS.get(candidate.defId);
      toast.show(`Requires ${def?.ageGate ?? "next"} age`);
    }
    return;
  }
  issuePlaceBuilding(
    world.inbox,
    world.tick,
    candidate.defId,
    candidate.tileX,
    candidate.tileY,
  );
  buildMenu.disarm(); // AoE2-style: one placement per arming
});

// Right-click cancels placement or disarms attack-move instead of
// ordering. Registered BEFORE wireOrderInput below so registration
// order lets it intercept the shared canvas contextmenu stream first.
canvas.addEventListener("contextmenu", (event: MouseEvent) => {
  disarmAttackMove();
  if (buildMenu.armedDefId() === null) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  buildMenu.disarm();
});

wireOrderInput({
  canvas,
  panelRoot: document.body,
  getGroundPoint: groundAt,
  selectionCount,
  selection: getSelectedEids,
  currentTick: () => world.tick,
  inbox: world.inbox,
  nodeAt,
  siteAt: (x, y) => {
    const eid = buildingAt(x, y);
    return eid !== undefined &&
      getBuildingSiteRow(world, comps, eid) !== undefined
      ? eid
      : undefined;
  },
  onMoveOrdered: (x, y) => moveMarkers.spawn(x, y),
});

// ---- Attack-move (A) + stop (S) keyboard orders (M2-T6, §2.13) -----
//
// A arms the attack-move cursor: the next left-click issues attackMove
// at that ground point (red-ring feedback) instead of selecting. S
// stops the selection immediately. Escape or a right-click disarms.

let attackMoveArmed = false;

function disarmAttackMove(): void {
  if (!attackMoveArmed) return;
  attackMoveArmed = false;
}

window.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.repeat || event.metaKey || event.ctrlKey) return;
  const key = event.key.toLowerCase();
  if (key === "escape") {
    disarmAttackMove();
    return;
  }
  if (selectionCount() === 0) return;
  if (key === "a") {
    attackMoveArmed = true;
    toast.show("Attack-move — click a destination");
  } else if (key === "s") {
    issueStop(world.inbox, world.tick, getSelectedEids());
    toast.show("Stop");
  }
});

const controlGroups = wireControlGroups({
  getFrame: () => staging ?? null,
  selection: getSelectedEids,
  setSelection,
  setCenter: (x, y) => cameraRig.setCenter(x, y),
});

const minimap = createMinimap({
  layers: world.layers,
  getFrame: () => staging ?? null,
  isSelected,
  fog: {
    isVisible: (x, y) => fog.isVisible(x, y, VIEWER),
    isExplored: (x, y) => fog.isExplored(x, y, VIEWER),
  },
  isOwn: (eid) => {
    const combat = world.rowsByComponentId.get(comps.combatId)?.get(eid);
    return !combat || combat[1] === VIEWER;
  },
  groundPointAt: groundAt,
  setCenter: (x, y) => cameraRig.setCenter(x, y),
});

const topbar = createTopbar(world.seed);

// ---- Game flow (M2-T10): surrender control + victory overlay -----------------
//
// The overlay polls the SAME VictoryCheck rows the digests hash, so the
// screen cannot disagree with the sim. Restart tears this page down and
// re-boots the session bootstrap from a FRESH seed; the handoff rides
// localStorage so one stash fires exactly one restart.

let matchDecidedShown = false;

const victoryScreen = createVictoryScreen({
  onRestart: () => {
    stashNextSeed(window.localStorage, freshSeed(world.seed));
    window.location.reload();
  },
});

const surrenderControl = createSurrenderControl(() => {
  if (matchDecidedShown) return;
  world.inbox.submit({
    kind: SURRENDER_COMMAND_KIND,
    targetTick: world.tick + 1,
    data: { playerId: PLAYER_ONE },
  });
  toast.show("Surrendering…");
  surrenderControl.setEnabled(false);
});

function pollMatchOutcome(): void {
  if (matchDecidedShown) return;
  const outcome = evaluateOutcome(world, comps);
  if (!outcome.decided) return;
  matchDecidedShown = true;
  surrenderControl.setEnabled(false);
  const viewerLoss = outcome.losers.find(
    (record) => record.playerId === VIEWER,
  );
  let enemyUnitsLost = 0;
  for (const record of outcome.losers) {
    if (record.playerId !== VIEWER) {
      enemyUnitsLost += unitsLostOf(world, comps, record.playerId);
    }
  }
  victoryScreen.show({
    side: viewerLoss !== undefined ? "defeat" : "victory",
    reason: viewerLoss?.reason ?? outcome.losers[0]?.reason ?? "conquest",
    stats: {
      ticksElapsed: world.tick,
      viewerUnitsLost: unitsLostOf(world, comps, VIEWER),
      enemyUnitsLost,
    },
  });
}

// Building visuals (one instanced draw call) fed from the pure
// building-snapshot mirror, plus the single-building selection panel.
const buildingLayer = createBuildingLayer();
scene.add(buildingLayer.mesh);
let buildingFrame = captureBuildingSnapshot(world, comps);

const buildingPanel = createBuildingPanel({
  currentTick: () => world.tick,
  inbox: world.inbox,
  getData: () => {
    const selected = getSelectedEids();
    if (selected.length !== 1) return undefined;
    const eid = selected[0]!;
    const siteRow = getBuildingSiteRow(world, comps, eid);
    if (siteRow) {
      const def = buildingDefOf(buildingIdOfCode(siteRow[1]!));
      let builders = 0;
      for (const other of world.entities) {
        if (getAssignedSite(world, comps, other) === eid) builders += 1;
      }
      return {
        title: `${def.name} — under construction`,
        progress01: siteRow[2]! / (def.buildTime * WORK_MILLI_SCALE),
        builders,
        pop: {
          current: populationOf(world, comps),
          cap: populationCapOf(world, comps),
        },
      };
    }
    const builtRow = getBuildingRow(world, comps, eid);
    if (!builtRow) return undefined;
    const def = buildingDefOf(buildingIdOfCode(builtRow[1]!));
    // M2-T3: recipe workshops show their current recipe, live per-input
    // availability across both ledgers and the run/stall state — the
    // exact rows golden digests hash. M4-T1: workplaces also surface
    // their serving foreman and the ranked appointment list.
    const recipes = recipesForBuilding(def.id);
    if (recipes.length > 0) {
      const cycle = getProductionCycleRow(world, comps, eid);
      const recipe = recipeDefOf(
        cycle ? recipeIdOfCode(cycle[1]!) : recipes[0]!.id,
      );
      const inputs = recipe.inputs.map((input) => ({
        slug: input.defId,
        need: input.qty,
        have: ledgerAmountOfSlug(world, comps, PLAYER_ONE, input.defId),
      }));
      const missing = inputs.find((input) => input.have < input.need);
      const remaining = cycle?.[2] ?? 0;
      let state: string;
      if (remaining > 0) {
        state = `running ${(remaining / 30).toFixed(1)}s`;
      } else if (missing) {
        state = `stalled — need ${missing.slug} ${String(missing.have)}/${String(missing.need)}`;
      } else {
        state = "idle — no crafter";
      }
      const domain = domainOfBuildingDef(def.id) ?? 0;
      const foremanEntry = foremanRowOf(world, comps, eid);
      const foremanLabel =
        foremanEntry === undefined
          ? undefined
          : `Foreman ${popNameOf(world, comps, foremanEntry.foremanPopEid) ?? "??"} · rating ${managementRatingOf(world, comps, foremanEntry.foremanPopEid, domain).toFixed(1)}`;
      return {
        title: def.name,
        buildingEid: eid,
        pop: {
          current: populationOf(world, comps),
          cap: populationCapOf(world, comps),
        },
        production: {
          recipeLabel: recipe.name,
          line: `${inputs
            .map(
              (input) =>
                `${input.slug} ${String(input.have)}/${String(input.need)}`,
            )
            .join(" · ")} · ${state}`,
        },
        foreman: foremanLabel,
        candidates: managementCandidatesOf(world, comps, PLAYER_ONE, domain)
          .slice(0, 5)
          .map((candidate) => ({
            popId: candidate.popEid,
            label: `${candidate.name} · rating ${candidate.rating.toFixed(1)}`,
          })),
      };
    }
    if (!def.trainQueue) return { title: def.name };
    return {
      title: def.name,
      queue: readTrainQueue(world, comps, eid).map((entry) => ({
        label: unitDefOf(unitIdOfCode(entry.unitCode)).name,
        remainingTicks: entry.remainingTicks,
      })),
      pop: {
        current: populationOf(world, comps),
        cap: populationCapOf(world, comps),
      },
      canTrain: canEnqueueTraining(world, comps, eid),
    };
  },
});

// Pop card (M3-T9): exactly one selected named Pop renders their
// identity/traits/skills/body/morale sheet — fed by the pure sim
// read-row exporter so chrome and digests cannot disagree.
const popCard = createPopCard({
  getData: () => {
    const selected = getSelectedEids();
    if (selected.length !== 1) return undefined;
    const eid = selected[0]!;
    if (world.rowsByComponentId.get(comps.identityId)?.has(eid) !== true) {
      return undefined;
    }
    return buildPopCard(world, comps, eid);
  },
});

// Domain strategy sliders (M4-T1, §2.7): one block per managed domain,
// fed from the same Manager/StrategySliders rows the sim enforces.
const DOMAIN_PANEL_WORKPLACE_CAP = 6;

const domainPanel = createDomainPanel({
  currentTick: () => world.tick,
  inbox: world.inbox,
  getData: (): DomainPanelData => {
    const buildingRows = world.rowsByComponentId.get(comps.buildingId);
    const domains = DOMAIN_NAMES.map((domainSlug, domain) => {
      const managerEid = managerOfDomain(world, comps, PLAYER_ONE, domain);
      const workplaces: number[] = [];
      if (buildingRows) {
        for (const eid of world.entities) {
          const row = buildingRows.get(eid);
          if (!row || row[0] !== PLAYER_ONE) continue;
          const def = buildingDefOf(buildingIdOfCode(row[1]!));
          if (domainOfBuildingDef(def.id) !== domain) continue;
          if (def.workSlots <= 0) continue;
          workplaces.push(eid);
          if (workplaces.length >= DOMAIN_PANEL_WORKPLACE_CAP) break;
        }
      }
      const stored =
        managerEid !== undefined
          ? strategyWeightsOf(world, comps, managerEid)
          : undefined;
      return {
        domainSlug,
        managerLabel:
          managerEid === undefined
            ? undefined
            : `Manager ${popNameOf(world, comps, managerEid) ?? "??"} · rating ${managementRatingOf(world, comps, managerEid, domain).toFixed(1)}`,
        weights: workplaces.map((eid, index) => ({
          workplaceEid: eid,
          label: `#${String(eid)} workplace`,
          weight: stored?.[index] ?? 1,
        })),
      };
    });
    return { domains };
  },
  issueStrategy: ({ domainSlug, weights }) => {
    const domain = DOMAIN_NAMES.indexOf(domainSlug);
    if (domain < 0) return;
    world.inbox.submit({
      kind: "setStrategy",
      targetTick: world.tick + 1,
      data: { domain, weights },
    });
  },
});

// Paint chrome immediately; the loop refreshes it from here on.
topbar.update(world.tick, "—");
minimap.redraw();

// Flat white rings under selected units (one instanced draw call),
// fed from the same interpolated mirror sample as the billboards.
const selectionRings = createSelectionRings(scene, world.layers);
const ringScratch = new Float32Array(SELECTION_RING_CAPACITY * 2);
let ringScratchCount = 0;
const SELECTION_RING_WRITE_CAP = SELECTION_RING_CAPACITY;

// Instanced health bars — the SECOND (and last) overlay draw call
// (SPEC §7). Instances come from the three-free packer each frame.
const healthBars = createHealthBars(scene);
const healthBarArrays: HealthBarAttributeArrays = {
  origins: new Float32Array(HEALTH_BAR_CAPACITY * 3),
  fractions: new Float32Array(HEALTH_BAR_CAPACITY),
};

let fpsFrames = 0;
let fpsWindowStart = performance.now();
let fpsText = "—";
let minimapSinceRedrawMs = 0;

function updateFps(now: number): void {
  fpsFrames++;
  if (now - fpsWindowStart >= 500) {
    fpsText = String(Math.round((fpsFrames * 1000) / (now - fpsWindowStart)));
    fpsFrames = 0;
    fpsWindowStart = now;
  }
}

// ---- The loop ---------------------------------------------------------------

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  cameraRig.resize(window.innerWidth, window.innerHeight);
});

let lastFrame = performance.now();
let accumulator = 0;
/** Render-clock seconds feeding the shader's quantized playback. */
let spriteTimeSec = 0;
/** Combined units+buildings live-eid feed for selection pruning. */
let combinedEids = new Int32Array(0);

function frame(
  now: number,
  villagerLayer: ReturnType<typeof createUnitSpriteLayer>,
): void {
  requestAnimationFrame((next) => frame(next, villagerLayer));
  const frameMs = Math.min(now - lastFrame, FRAME_CLAMP_MS);
  lastFrame = now;
  spriteTimeSec += frameMs / 1000;
  accumulator += frameMs;

  let steps = 0;
  while (accumulator >= TICK_DT_MS && steps < MAX_STEPS_PER_FRAME) {
    step(world); // may hold a tick internally on a late path response
    steps += 1;
    accumulator -= TICK_DT_MS;
  }
  if (steps === MAX_STEPS_PER_FRAME && accumulator > TICK_DT_MS) {
    accumulator = 0; // shed backlog rather than death-spiral catching up
  }

  // Snapshot AFTER stepping, interpolate BETWEEN the last two ticks.
  staging = captureSimSnapshot(world, comps, { reusable: staging });
  buildingFrame = captureBuildingSnapshot(world, comps, {
    reusable: buildingFrame,
  });

  // Fog texture rotation (SPEC §2.9): on a fog-dirty tick boundary,
  // curr becomes prev and fresh planes land in curr; uBlend then sweeps
  // 0→1 across the tick interval with the interpolation alpha.
  if (fog.revision !== fogRevision) {
    fogRevision = fog.revision;
    copyFogTexture(
      fogUniforms.uFogCurr.value as DataTexture,
      fogUniforms.uFogPrev.value as DataTexture,
    );
    writeFogPlaneIntoTexture(
      fogUniforms.uFogCurr.value as DataTexture,
      fog.state,
      VIEWER,
    );
  }

  pushFrame(mirror, staging);
  const alpha = Math.min(accumulator / TICK_DT_MS, 1);
  fogUniforms.uBlend.value = alpha;
  const sampledCount = sampleMirror(mirror, alpha, sampleOut);

  // M3-T6: day/night tint from the sim clock — background and light rig
  // scale together so nights are visibly navy and dawns warmly lit.
  const tint = sampleOut.lightTint!;
  const lum = Math.max(tint[0]!, tint[1]!, tint[2]!);
  scratchBackground.setRGB(
    baseBackground.r * (0.4 + 0.6 * tint[0]!),
    baseBackground.g * (0.4 + 0.6 * tint[1]!),
    baseBackground.b * (0.4 + 0.6 * tint[2]!),
  );
  scene.background = scratchBackground;
  sun.intensity = BASE_SUN_INTENSITY * (0.25 + 0.75 * lum);
  hemisphereLight.intensity = BASE_HEMI_INTENSITY * (0.35 + 0.65 * lum);

  // Entity CPU culling against the visible plane (SPEC §2.9) before
  // any instancing work.
  let visibleCount = 0;
  for (let i = 0; i < sampledCount; i++) {
    const x = sampleOut.positions[i * 2]!;
    const y = sampleOut.positions[i * 2 + 1]!;
    const seen =
      sampledCount > 0 && fog.isVisible(Math.floor(x), Math.floor(y), VIEWER);
    if (seen && visibleCount < RENDER_CAPACITY) {
      culledPositions[visibleCount * 2] = x;
      culledPositions[visibleCount * 2 + 1] = y;
      culledHeadings[visibleCount] = sampleOut.headings[i]!;
      visibleCount += 1;
    }
    barHpFractions[i] = seen ? sampleOut.hpFractions[i]! : 1;
  }

  // Selection bookkeeping against the fresh snapshot (prune dead).
  // Buildings ride the same live-eid feed so selected sites survive
  // pruning even though they are not movable units.
  if (buildingFrame.count > 0) {
    const total = staging.count + buildingFrame.count;
    if (combinedEids.length < total) combinedEids = new Int32Array(total * 2);
    combinedEids.set(staging.eids.subarray(0, staging.count), 0);
    combinedEids.set(
      buildingFrame.eids.subarray(0, buildingFrame.count),
      staging.count,
    );
    noteLiveEids(combinedEids, total);
  } else {
    noteLiveEids(staging.eids, staging.count);
  }

  villagerLayer.setTime(spriteTimeSec);
  writePopInstances(
    villagerLayer,
    culledPositions,
    culledHeadings,
    visibleCount,
  );

  // Building meshes repaint from the fresh snapshot every frame, gated
  // by fog: own buildings always render; enemy ones only while
  // observed, otherwise their memory ghost submits desaturated/static.
  let bCount = 0;
  for (
    let i = 0;
    i < buildingFrame.count && bCount < BUILDING_RENDER_CAP;
    i++
  ) {
    const eid = buildingFrame.eids[i]!;
    const ox = buildingFrame.origins[i * 2]!;
    const oy = buildingFrame.origins[i * 2 + 1]!;
    const w = buildingFrame.sizes[i * 2]!;
    const h = buildingFrame.sizes[i * 2 + 1]!;
    const siteRow = getBuildingSiteRow(world, comps, eid);
    const builtRow = getBuildingRow(world, comps, eid);
    const owner = (siteRow ?? builtRow)?.[0];
    let ghost = false;
    let keep = owner === VIEWER;
    if (!keep) {
      for (let dy = 0; dy < h && !keep && !ghost; dy++) {
        for (let dx = 0; dx < w; dx++) {
          if (fog.isVisible(Math.floor(ox) + dx, Math.floor(oy) + dy, VIEWER)) {
            keep = true;
            break;
          }
        }
      }
      if (!keep && viewerKnowledge.lastKnown(eid) !== undefined) {
        ghost = true;
        keep = true;
      }
    }
    if (!keep) continue;
    bEids[bCount] = eid;
    bOrigins[bCount * 2] = ox;
    bOrigins[bCount * 2 + 1] = oy;
    bSizes[bCount * 2] = w;
    bSizes[bCount * 2 + 1] = h;
    bStates[bCount] = buildingFrame.states[i]!;
    bProgress[bCount] = buildingFrame.progress[i]!;
    bGhosts[bCount] = ghost ? 1 : 0;
    bCount += 1;
  }
  buildingLayer.write(
    {
      count: bCount,
      eids: bEids,
      origins: bOrigins,
      sizes: bSizes,
      states: bStates,
      progress: bProgress,
    },
    world.layers,
    { isGhost: (index) => bGhosts[index] === 1 },
  );

  // Armed placement ghost follows the pointer each frame so it stays
  // glued while panning/zooming, not just on mousemove.
  const ghostCandidate = currentPlacementCheck();
  const armedDef =
    ghostCandidate !== null
      ? BUILDING_DEFINITIONS.get(ghostCandidate.defId)
      : undefined;
  if (ghostCandidate && armedDef) {
    buildGhost.show(
      {
        x: ghostCandidate.tileX,
        y: ghostCandidate.tileY,
        width: armedDef.footprint.width,
        height: armedDef.footprint.height,
      },
      ghostCandidate.ok,
      world.layers,
    );
  } else {
    buildGhost.hide();
  }

  // Selection rings ride the same interpolated sample as the sprites:
  // find each selected eid's ascending-eid rank and copy its position.
  if (selectionCount() > 0) {
    ringScratchCount = 0;
    for (const eid of getSelectedEids()) {
      if (ringScratchCount >= SELECTION_RING_WRITE_CAP) break;
      const rank = staging.eids.indexOf(eid);
      if (rank < 0) continue;
      ringScratch[ringScratchCount * 2] = sampleOut.positions[rank * 2]!;
      ringScratch[ringScratchCount * 2 + 1] =
        sampleOut.positions[rank * 2 + 1]!;
      ringScratchCount += 1;
    }
    selectionRings.write(ringScratch, ringScratchCount);
  } else {
    selectionRings.write(ringScratch, 0);
  }

  // Health bars — the second overlay draw call (SPEC §7). Damaged or
  // selected units only; the pure packer keeps the frame-loop CPU cost
  // a flat typed-array fill (headless-gated in tests/perf/overlays).
  selectedFlags.fill(0);
  if (selectionCount() > 0) {
    for (const eid of getSelectedEids()) {
      const rank = staging.eids.indexOf(eid);
      if (rank >= 0 && rank < RENDER_CAPACITY) selectedFlags[rank] = 1;
    }
  }
  const barCount = packHealthBarAttributes(
    healthBarArrays,
    {
      positions: sampleOut.positions,
      hpFractions: barHpFractions,
      selectedFlags,
      count: sampledCount,
    },
    groundHeights,
    HEALTH_BAR_CAPACITY,
  );
  healthBars.write(
    healthBarArrays.origins,
    healthBarArrays.fractions,
    barCount,
  );

  moveMarkers.update(frameMs / 1000);

  minimapSinceRedrawMs += frameMs;
  if (minimapSinceRedrawMs >= MINIMAP_REDRAW_MS) {
    minimapSinceRedrawMs = 0;
    minimap.redraw();
  }

  cameraRig.update(frameMs / 1000);
  updateFps(now);
  // Resource topbar polls the live Stockpile rows each frame — the same
  // rows golden digests hash, so chrome and sim cannot disagree. The
  // population/cap line rides along (M1-T10).
  const stockRow = stockpileSnapshot(world, comps).values().next().value;
  const popLine = `pop ${String(populationOf(world, comps))}/${String(populationCapOf(world, comps))}`;
  topbar.update(
    world.tick,
    fpsText,
    // Missing row (no stockpile entity yet) still renders the full
    // seven-slug zero line — formatStockpileLine fills missing codes.
    `${formatStockpileLine(stockRow ?? [])} · ${popLine}`,
  );
  topbar.updateAge(currentAgeRankOf(world, comps, PLAYER_ONE));
  controlGroups.refreshChips();
  buildMenu.refresh();
  buildingPanel.refresh();
  popCard.refresh();
  domainPanel.refresh();
  pollMatchOutcome();
  renderer.render(scene, cameraRig.camera);

  // SPEC §7 draw-call budget: terrain + instanced sprite field +
  // buildings + EXACTLY TWO overlay draws (selection rings + health
  // bars) must stay in the single digits. Logged every frame; the
  // browser-only overlay-count dev check lives in docs/m2-overlays.md.
  const calls = renderer.info.render.calls;
  console.assert(calls <= 9, `draw calls ${calls} exceed §7 handful budget`);
}

loadVillagerLayer()
  .then((villagerLayer) => {
    scene.add(villagerLayer.mesh);
    requestAnimationFrame((now) => frame(now, villagerLayer));
  })
  .catch((error: unknown) => {
    console.error("villager atlas failed to load", error);
    document.body.textContent =
      "Failed to load unit atlas — run `npm run bake:villager`.";
  });

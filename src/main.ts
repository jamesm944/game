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
  PCFSoftShadowMap,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  WebGLRenderer,
  type DataTexture,
} from "three";
import archerPng from "./assets/atlas/archer.png";
import archerJson from "./assets/atlas/archer.frames.json";
import knightPng from "./assets/atlas/knight.png";
import knightJson from "./assets/atlas/knight.frames.json";
import manAtArmsPng from "./assets/atlas/man-at-arms.png";
import manAtArmsJson from "./assets/atlas/man-at-arms.frames.json";
import militiaPng from "./assets/atlas/militia.png";
import militiaJson from "./assets/atlas/militia.frames.json";
import monkPng from "./assets/atlas/monk.png";
import monkJson from "./assets/atlas/monk.frames.json";
import scoutCavalryPng from "./assets/atlas/scout-cavalry.png";
import scoutCavalryJson from "./assets/atlas/scout-cavalry.frames.json";
import skirmisherPng from "./assets/atlas/skirmisher.png";
import skirmisherJson from "./assets/atlas/skirmisher.frames.json";
import villagerPng from "./assets/atlas/villager.png";
import villagerJson from "./assets/atlas/villager.frames.json";
import type { UnitSpriteLayer } from "./render/unitSprites";
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
  spawnResourceNode,
  spawnUnit,
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
  unitCodeOf,
  UNIT_DEFINITIONS,
} from "./data/definitions";
import {
  PLAYER_ONE,
  ledgerAmountOfSlug,
  stockpileSnapshot,
} from "./sim/core/stockpile";
import { TICK_DT_MS, step, type World } from "./sim/core/world";
import type { SimComponents } from "./sim/components";
import { canEnqueueTraining } from "./sim/systems/training";
import { currentAgeRankOf, isDefAgeUnlocked } from "./sim/systems/age";
import { canAfford, validatePlacement, stampFinishedBuilding, traceWallRun } from "./sim/systems/placement";
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
  captureSkirmishSave,
  consumeNextSeed,
  createSkirmishWorld,
  freshSeed,
  restoreSkirmishSession,
  stashNextSeed,
  SaveNotSafeError,
} from "./game/session";
import type { SkirmishWorld } from "./game/session";
import { replayOutcomeOf, runReplayHeadless } from "./game/replayPlayer";
import { parseReplayJson } from "./sim/replay/play";
import {
  ReplayRecorder,
  replayFileName,
  serializeReplay,
} from "./sim/replay/record";
import {
  AUTOSAVE_INTERVAL_TICKS,
  assertMapHash,
  createIdbSaveStore,
  decodeAgeof,
  pickAutosaveTarget,
} from "./game/saveManager";
import { parsePayload } from "./sim/save/serialize";
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
import { setPlayerAgeRank } from "./sim/components/age";
import {
  DOMAIN_NAMES,
  domainOfBuildingDef,
  foremanRowOf,
  strategyWeightsOf,
} from "./sim/components/management";
import { RtsCamera } from "./render/camera";
import { MAX_VIEW_HEIGHT, MIN_VIEW_HEIGHT } from "./render/camera";
import { hookGestureGate } from "./audio/context";
import { createBuses, setBusVolume } from "./audio/buses";
import { VoicePool } from "./audio/voices";
import { AudioScheduler } from "./audio/scheduler";
import { collectAudioIntents, minuteOfDay } from "./audio/simBridge";
import {
  createBuildingModelsLayer,
  type BuildingModelsLayer,
} from "./render/buildingModels";
import {
  createRelicModelsLayer,
  type RelicModelsLayer,
} from "./render/relicModels";
import {
  createResourceModelsLayer,
  type ResourceModelsLayer,
} from "./render/resourceModels";
import {
  captureRelicSnapshot,
  type RelicSnapshotFrame,
} from "./sim/mirror";
import {
  relicsOf,
  RELIC_GROUND,
  RELIC_CARRIED,
} from "./sim/components/relic";
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
import {
  PLAYBACK_QUANTUM_FPS,
  playbackRateForZoom,
} from "./render/atlasFrames";
import { createHealthBars } from "./render/healthBars";
import {
  HEALTH_BAR_CAPACITY,
  packHealthBarAttributes,
  type HealthBarAttributeArrays,
} from "./render/overlayPack";
import { issueAttackMove, issueGather, issueStop } from "./ui/orders";
import { spawnCombatUnit } from "./sim/components/combat";
import { RESOURCE_WOOD } from "./sim/components/economy";
import {
  issuePlaceBuilding,
  snapGhostOrigin,
  wireBuildMenu,
} from "./ui/buildMenu";
import { createBuildingPanel } from "./ui/buildingPanel";
import { createDomainPanel, type DomainPanelData } from "./ui/domainPanel";
import {
  createCompanyPanel,
  type CharterPayload,
  type CompanyPanelData,
} from "./ui/companyPanel";
import {
  APPROVAL_AUTO_APPROVE,
  approvalModeOf,
  branchRowOf,
  companyOriginOf,
  companyRowOf,
  EXPANSION_LOG_APPROVED,
  EXPANSION_LOG_EXECUTED,
  EXPANSION_LOG_FOUNDED,
  EXPANSION_LOG_REJECTED,
  EXPANSION_LOG_SEIZED,
  expansionLogOf,
  pendingExpansionOf,
  treasuryDeltasOf,
  type ExpansionLogEntry,
} from "./sim/components/company";
import { ORGANIC_DISSOLVE_GRACE_TICKS } from "./sim/systems/companies";
import type { CompanyPanelBranch, CompanyPanelEntry } from "./ui/companyPanel";
import { popNameOf } from "./sim/components/pop";
import { createPopCard } from "./ui/popCard";
import { buildPopCard } from "./sim/popCard";
import { wireControlGroups } from "./ui/controlGroups";
import { createTopbar, formatStockpileLine } from "./ui/hud";
import { victoryPathReadouts } from "./sim/systems/victory";
import { createVictoryPathsPanel } from "./ui/victoryPaths";
import { createToastHost } from "./ui/toast";
import { sanitizeSlotName, createPauseMenu } from "./ui/pauseMenu";
import {
  consumeDifficulty,
  createSettingsPanel,
  formatAutosaveInterval,
  persistVolume,
  readStoredVolumes,
  stashDifficulty,
  type BusVolumeName,
} from "./ui/settings";
import { createDevStatsHud, type DevStatsHandle } from "./ui/devstats";
import {
  createReplayDesyncPanel,
  createReplayProgressOverlay,
} from "./ui/replayOverlay";
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
 * Settings handoff (M5-T4): a stashed difficulty choice (ui/settings.ts
 * panel) feeds THIS boot's session bootstrap — one stash fires exactly
 * one match, same semantics as the restart seed above. Absent a stash
 * the session default ("normal") applies.
 */
const chosenDifficulty = consumeDifficulty(window.localStorage);
/**
 * Mirror/overlay sample capacity: sized past the dev start population
 * so M2-T6 trained armies render without re-allocating the frame loop's
 * scratch arrays.
 */
const RENDER_CAPACITY = 512;
/** SPEC §7 loop safety: clamp + max-steps-per-frame cap. */
const FRAME_CLAMP_MS = 250;
const MAX_STEPS_PER_FRAME = 5;
/** Billboard world size: ~1.5 tiles tall so units read at map zoom. */
const SPRITE_WORLD_WIDTH = 0.95;
const SPRITE_WORLD_HEIGHT = 1.5;

// ---- World (the shared skirmish bootstrap — identical to tests) -------------
//
// M5-T2: boot consumes a stashed `.ageof` container first — the pause
// menu's Load button stashes one and reloads, so a loaded match boots
// through THIS exact path (restore = byte-copy + digest verification,
// no replay). Any rejection falls back to the fresh bootstrap loudly.

const saveStore = createIdbSaveStore();

async function takePendingLoadContainer(): Promise<Uint8Array | undefined> {
  const blob = await saveStore.takePendingLoad();
  if (blob === undefined) return undefined;
  return new Uint8Array(await blob.arrayBuffer());
}

let session: SkirmishWorld;
const pendingLoad = await takePendingLoadContainer();
// Replay recording (M5-T3): fresh matches record from tick 0 — the
// bootstrap attaches the recorder before its own AI drafts so only
// player-originated commands enter the artifact. Restored saves do NOT
// record (their world resumed from bytes, not replay).
let recorder: ReplayRecorder | undefined =
  pendingLoad === undefined ? new ReplayRecorder() : undefined;
if (pendingLoad !== undefined) {
  try {
    const restored = await restoreSkirmishSession(pendingLoad, {
      createTransport: () => createWorkerTransport(createPathWorkerFactory()),
      aiDifficulty: chosenDifficulty,
    });
    session = restored;
    console.info(
      `restored .ageof save at tick ${String(restored.restoredFromTick)}`,
    );
  } catch (error) {
    console.error("save restore rejected", error);
    const banner = document.createElement("div");
    banner.id = "toast";
    banner.className = "visible";
    banner.textContent = `Save failed to load: ${error instanceof Error ? error.message : String(error)} — started a fresh match.`;
    document.body.appendChild(banner);
    window.setTimeout(() => banner.remove(), 6000);
    session = createSkirmishWorld(bootSeed, {
      createTransport: () => createWorkerTransport(createPathWorkerFactory()),
      aiDifficulty: chosenDifficulty,
      spawnRelics: true,
    });
  }
} else {
  session = createSkirmishWorld(bootSeed, {
    createTransport: () => createWorkerTransport(createPathWorkerFactory()),
    replay: recorder,
    aiDifficulty: chosenDifficulty,
    spawnRelics: true,
  });
}
recorder?.beginPlay();
const { world, comps, fog } = session;

if (typeof window !== "undefined") {
  (window as any).__game = {
    world,
    comps,
    session,
    spawnUnit,
    spawnCombatUnit,
    spawnResourceNode,
    RESOURCE_WOOD,
    issueGather,
    setPlayerAge: (rank: number) => {
      setPlayerAgeRank(world, comps, PLAYER_ONE, rank);
    },
    stampFinishedBuilding: (defId: string, x: number, y: number, options?: { playerId?: number }) => {
      return stampFinishedBuilding(world, comps, defId as any, x, y, options ?? { playerId: PLAYER_ONE });
    },
    unitCodeOf,
    unitDefOf,
    validatePlacement: (defId: string, x: number, y: number) => {
      return validatePlacement(world, comps, defId, x, y, PLAYER_ONE);
    },
  };
}

/**
 * Advance one sim tick — through the recorder while recording so
 * system-emitted commands classify as sim-internal.
 */
function advanceOneTick(): void {
  if (recorder?.recording === true) recorder.stepWorld();
  else step(world);
}

// ---- Renderer ---------------------------------------------------------------

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // §7 budget
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(0x10141c);

const hemisphereLight = new HemisphereLight(0xcfd8e8, 0x3a4436, 1.05);
scene.add(hemisphereLight);
const sun = new DirectionalLight(0xfff2d9, 1.35);
sun.position.set(world.layers.size * 0.5 + 40, 75, world.layers.size * 0.5 + 25);
sun.target.position.set(world.layers.size * 0.5, 0, world.layers.size * 0.5);
scene.add(sun.target);
sun.castShadow = true;
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 180;
sun.shadow.camera.left = -world.layers.size * 0.6;
sun.shadow.camera.right = world.layers.size * 0.6;
sun.shadow.camera.top = world.layers.size * 0.6;
sun.shadow.camera.bottom = -world.layers.size * 0.6;
sun.shadow.mapSize.width = 2048;
sun.shadow.mapSize.height = 2048;
sun.shadow.bias = -0.0005;
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
terrain.receiveShadow = true;
scene.add(terrain);

const cameraRig = new RtsCamera({ mapSize: world.layers.size });
cameraRig.resize(window.innerWidth, window.innerHeight);
const startBuiltRows = world.rowsByComponentId.get(comps.buildingId);
const startPosRows = world.rowsByComponentId.get(comps.positionId);
let startCamX = world.layers.size / 2;
let startCamY = world.layers.size / 2;
if (startBuiltRows && startPosRows) {
  for (const [eid, r] of startBuiltRows.entries()) {
    if (r[0] === PLAYER_ONE && r[1] === 1) { // Player 1 TC
      const p = startPosRows.get(eid);
      if (p && p[0] !== undefined && p[1] !== undefined) {
        startCamX = p[0] + 1.5;
        startCamY = p[1] + 1.5;
        break;
      }
    }
  }
}
cameraRig.setCenter(startCamX, startCamY);
if (typeof window !== "undefined" && (window as any).__game) {
  (window as any).__game.cameraRig = cameraRig;
}

// ---- Audio (M5-T1): gesture-gated context, buses, voice pool, scheduler -----
hookGestureGate();
const audioCtxHolder: { current: AudioContext | null } = { current: null };
const getAudioCtx = (): AudioContext | null => {
  if (!audioCtxHolder.current) {
    const Ctor = window.AudioContext;
    if (Ctor) audioCtxHolder.current = new Ctor();
  }
  if (audioCtxHolder.current?.state === "suspended")
    void audioCtxHolder.current.resume();
  return audioCtxHolder.current;
};
const audioBusesHolder: { current: ReturnType<typeof createBuses> | null } = {
  current: null,
};
const voicePool = new VoicePool(
  getAudioCtx,
  () => {
    const ctx = getAudioCtx();
    if (!audioBusesHolder.current && ctx)
      audioBusesHolder.current = createBuses(ctx);
    return audioBusesHolder.current;
  },
  () => {
    const cam = cameraRig.camera as OrthographicCameraLike;
    return {
      leftX: cam.position.x + cam.left,
      rightX: cam.position.x + cam.right,
    };
  },
);
const audioScheduler = new AudioScheduler();
let lastAudioTick = -1;
interface OrthographicCameraLike {
  position: { x: number };
  left: number;
  right: number;
}

// Mirror plumbing: reusable capture staging + allocation-free sampling.
let staging: SimSnapshotFrame | undefined;
const sampleOut: MirrorSampleOut = {
  positions: new Float32Array(RENDER_CAPACITY * 2),
  headings: new Float32Array(RENDER_CAPACITY),
  hpFractions: new Float32Array(RENDER_CAPACITY),
  defCodes: new Uint8Array(RENDER_CAPACITY),
  activityCodes: new Uint8Array(RENDER_CAPACITY),
  ownerIds: new Uint8Array(RENDER_CAPACITY),
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
const barHpFractions = new Float32Array(RENDER_CAPACITY);
/** Building feed cap mirrors the instanced layer's MAX_BUILDINGS. */
const BUILDING_RENDER_CAP = 128;
const bOrigins = new Float32Array(BUILDING_RENDER_CAP * 2);
const bSizes = new Float32Array(BUILDING_RENDER_CAP * 2);
const bStates = new Uint8Array(BUILDING_RENDER_CAP);
const bProgress = new Float32Array(BUILDING_RENDER_CAP);
const bEids = new Int32Array(BUILDING_RENDER_CAP);
const bGhosts = new Uint8Array(BUILDING_RENDER_CAP);
const bDefCodes = new Uint8Array(BUILDING_RENDER_CAP);
const bOwnerIds = new Uint8Array(BUILDING_RENDER_CAP);
const bAgeRanks = new Uint8Array(BUILDING_RENDER_CAP);

interface LayerScratch {
  count: number;
  positions: Float32Array;
  headings: Float32Array;
  actionSlots: Float32Array;
  tints: Float32Array;
  groundHeights: Float32Array;
}

const UNIT_SPECS: Record<
  string,
  { png: string; json: unknown; width: number; height: number }
> = {
  villager: { png: villagerPng, json: villagerJson, width: 0.95, height: 1.5 },
  militia: { png: militiaPng, json: militiaJson, width: 0.95, height: 1.5 },
  "man-at-arms": { png: manAtArmsPng, json: manAtArmsJson, width: 0.95, height: 1.5 },
  longswordsman: { png: manAtArmsPng, json: manAtArmsJson, width: 1.0, height: 1.55 },
  "two-handed-swordsman": { png: manAtArmsPng, json: manAtArmsJson, width: 1.05, height: 1.6 },
  "scout-cavalry": { png: scoutCavalryPng, json: scoutCavalryJson, width: 1.3, height: 1.7 },
  "light-cavalry": { png: scoutCavalryPng, json: scoutCavalryJson, width: 1.35, height: 1.75 },
  knight: { png: knightPng, json: knightJson, width: 1.3, height: 1.7 },
  cavalier: { png: knightPng, json: knightJson, width: 1.35, height: 1.75 },
  paladin: { png: knightPng, json: knightJson, width: 1.4, height: 1.8 },
  archer: { png: archerPng, json: archerJson, width: 0.95, height: 1.5 },
  arbalest: { png: archerPng, json: archerJson, width: 1.0, height: 1.55 },
  skirmisher: { png: skirmisherPng, json: skirmisherJson, width: 0.95, height: 1.5 },
  monk: { png: monkPng, json: monkJson, width: 0.95, height: 1.5 },
  "trade-cart": { png: scoutCavalryPng, json: scoutCavalryJson, width: 1.3, height: 1.6 },
};

const ACTIVITY_NAMES: readonly string[] = [
  "idle",
  "walk",
  "gather-wood",
  "gather-food",
  "gather-gold",
  "build",
  "carry-wood",
  "carry-food",
  "carry-ore",
  "attack",
  "death",
];

const layerScratches: LayerScratch[] = [];
const slotLookup: number[][] = [];
for (let i = 0; i < 32; i++) {
  layerScratches.push({
    count: 0,
    positions: new Float32Array(RENDER_CAPACITY * 2),
    headings: new Float32Array(RENDER_CAPACITY),
    actionSlots: new Float32Array(RENDER_CAPACITY),
    tints: new Float32Array(RENDER_CAPACITY * 3),
    groundHeights: new Float32Array(RENDER_CAPACITY),
  });
  slotLookup.push(new Array(16).fill(0));
}

async function loadUnitLayers(): Promise<Array<UnitSpriteLayer | undefined>> {
  const loader = new TextureLoader();
  const layersByCode: Array<UnitSpriteLayer | undefined> = new Array(32).fill(undefined);

  for (const [id, spec] of Object.entries(UNIT_SPECS)) {
    const code = unitCodeOf(id);
    const texture = await loader.loadAsync(spec.png);
    texture.colorSpace = SRGBColorSpace;
    const layer = createUnitSpriteLayer({
      atlasTexture: texture,
      indexJson: spec.json,
      maxInstances: RENDER_CAPACITY,
      worldWidth: spec.width,
      worldHeight: spec.height,
    });
    layersByCode[code] = layer;

    const def = UNIT_DEFINITIONS.get(id);
    const anims = def?.activityAnims ?? {};
    const defaultIdle = layer.atlas.actions.find((a) => a.name === "idle")?.slot ?? 0;

    for (let actCode = 0; actCode < ACTIVITY_NAMES.length; actCode++) {
      const actName = ACTIVITY_NAMES[actCode]!;
      let clip = anims[actName];
      if (!clip) {
        if (actName.startsWith("gather-")) {
          clip = anims["chop"] ?? anims["farm"] ?? anims["mine"];
        } else if (actName.startsWith("carry-")) {
          clip = anims["walk"];
        }
      }
      if (!clip) clip = anims["idle"] ?? "idle";
      const action = layer.atlas.actions.find((a) => a.name === clip);
      slotLookup[code]![actCode] = action ? action.slot : defaultIdle;
    }
  }

  return layersByCode;
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
  isPlacementArmed: () => buildMenu.armedDefId() !== null,
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

// ---- Settings panel (M5-T4): audio buses, difficulty, autosave line ----
//
// Volume moves persist through setBusVolume once the gesture-gated
// context has built the bus graph; until then the storage-only path
// writes the identical key/format so createBuses applies it on first
// unlock. Difficulty rides the localStorage stash into THIS file's
// session bootstrap above; the running match's knobs are fixed at boot.
const settingsPanel = createSettingsPanel({
  volumes: readStoredVolumes(window.localStorage),
  autosaveLabel: formatAutosaveInterval(AUTOSAVE_INTERVAL_TICKS),
  difficulty: session.aiDifficulty,
  onSetVolume: (name: BusVolumeName, value: number) => {
    const buses = audioBusesHolder.current;
    if (buses) setBusVolume(buses, name, value);
    else persistVolume(window.localStorage, name, value);
  },
  onSetDifficulty: (id) => {
    stashDifficulty(window.localStorage, id);
    toast.show(`AI ${id} — applies to the next match`);
  },
});
void settingsPanel;

// Dev-only §7 audit line (draw calls · triangles · playback band) —
// production builds ship without it; see docs/m5-manual.md.
let devStats: DevStatsHandle | undefined;
if (import.meta.env.DEV) devStats = createDevStatsHud();
/** Current LOD playback quantum — feeds the layer AND the dev line. */
let currentPlaybackFps = PLAYBACK_QUANTUM_FPS;

// ---- Saves + pause chrome (M5-T2, §2.12): slots, autosave, import/export -----
//
// Play time accumulates ONLY while unpaused; the autosave cadence fires
// every AUTOSAVE_INTERVAL_TICKS (~2 sim-minutes) of unpaused stepping,
// re-anchored from the restored tick after a load. Manual slots are
// user-named; Load stashes the container and reloads so the rebuilt
// session boots through THIS file's restore path byte-identically.

let playtimeSeconds =
  "playtimeSeconds" in session && typeof session.playtimeSeconds === "number"
    ? session.playtimeSeconds
    : 0;
let nextAutosaveAtTick = world.tick + AUTOSAVE_INTERVAL_TICKS;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Capture container bytes, tolerating a briefly-busy path pipeline
 * (saves wait for step boundaries; the worker usually drains in ms).
 */
async function captureContainerForSave(): Promise<Uint8Array> {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      return await captureSkirmishSave(session, playtimeSeconds);
    } catch (error) {
      if (error instanceof SaveNotSafeError && Date.now() < deadline) {
        await sleep(120);
        continue;
      }
      throw error;
    }
  }
}

function downloadAgeof(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: "application/octet-stream" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name}.ageof`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Replay export: plain JSON text, `<map>-<tick>.ageofreplay`. */
function downloadReplay(fileName: string, text: string): void {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const AUTOSAVE_NAME_SET = new Set(["autosave-1", "autosave-2", "autosave-3"]);

const pauseMenu = createPauseMenu({
  onResume: () => {}, // the menu hides itself; the loop reads isOpen
  onSave: async (name) => {
    const bytes = await captureContainerForSave();
    await saveStore.put({
      name,
      savedAt: Date.now(),
      playtimeSeconds,
      saveBlob: new Blob([bytes as BlobPart]),
    });
    toast.show(`Saved “${name}”`);
  },
  onLoad: async (name) => {
    const record = await saveStore.get(name);
    if (record === undefined) throw new Error(`no such slot: ${name}`);
    const bytes = new Uint8Array(await record.saveBlob.arrayBuffer());
    decodeAgeof(bytes); // loud pre-flight BEFORE tearing the page down
    await saveStore.putPendingLoad(new Blob([bytes as BlobPart]));
    window.location.reload();
  },
  onExport: async (name) => {
    const record = await saveStore.get(name);
    if (record === undefined) throw new Error(`no such slot: ${name}`);
    downloadAgeof(name, new Uint8Array(await record.saveBlob.arrayBuffer()));
  },
  onDelete: async (name) => {
    await saveStore.delete(name);
    toast.show(`Deleted “${name}”`);
  },
  onImport: async (file) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Full header validation without building a world: magic → version
    // → framing → gzip → payload sections → MAP HASH.
    const { meta, payload } = decodeAgeof(bytes);
    assertMapHash(meta, parsePayload(payload).mapBytes);
    const baseName = sanitizeSlotName(file.name.replace(/\.ageof$/i, ""));
    const name = baseName.length > 0 ? baseName : "imported";
    let unique = name;
    for (let attempt = 2; ; attempt++) {
      const existing = await saveStore.get(unique);
      if (existing === undefined) break;
      unique = `${name} ${String(attempt)}`;
    }
    await saveStore.put({
      name: unique,
      savedAt: Date.now(),
      playtimeSeconds: meta.playtimeSeconds,
      saveBlob: new Blob([bytes as BlobPart]),
    });
    toast.show(`Imported “${unique}”`);
  },
  onExportReplay: async () => {
    const active = recorder;
    if (active === undefined) {
      throw new Error(
        "No replay records this match — replays record from a fresh match start only.",
      );
    }
    // One artifact per recording; finalize detaches the drain observer.
    const artifact = active.finalize();
    recorder = undefined;
    downloadReplay(replayFileName(artifact), serializeReplay(artifact));
    toast.show(
      `Replay exported — ${String(artifact.commands.length)} orders · tick ${String(artifact.ticks)}`,
    );
  },
  onImportReplay: async (file) => {
    const text = await file.text();
    // Loud format validation BEFORE any playback chrome appears.
    const replay = parseReplayJson(text);
    pauseMenu.hide(); // the menu handle hides itself below via guarded()
    const overlay = createReplayProgressOverlay();
    overlay.setProgress(0, replay.ticks);
    try {
      const result = await runReplayHeadless(replay, {
        createTransport: () => createWorkerTransport(createPathWorkerFactory()),
        onProgress: (tickDone, total) => overlay.setProgress(tickDone, total),
      });
      overlay.complete();
      if (result.divergence !== undefined) {
        createReplayDesyncPanel(result.divergence);
        toast.show("Replay DESYNCED — see the report");
        return;
      }
      const outcome = replayOutcomeOf(result.session);
      if (outcome.decided) {
        victoryScreen.show({
          side: outcome.side,
          reason: outcome.reason,
          stats: outcome.stats,
        });
      } else {
        toast.show(
          `Replay complete — ${String(replay.ticks)} ticks, no divergence`,
        );
      }
    } catch (error) {
      overlay.fail(error instanceof Error ? error.message : String(error));
    }
  },
  listSlots: async () => {
    const records = await saveStore.getAll();
    return records
      .map((record) => ({
        name: record.name,
        savedAt: record.savedAt,
        playtimeSeconds: record.playtimeSeconds,
      }))
      .sort((a, b) => {
        const aAuto = AUTOSAVE_NAME_SET.has(a.name) ? 0 : 1;
        const bAuto = AUTOSAVE_NAME_SET.has(b.name) ? 0 : 1;
        if (aAuto !== bAuto) return aAuto - bAuto;
        if (aAuto === 0) return a.name.localeCompare(b.name);
        return b.savedAt - a.savedAt;
      });
  },
});

/** Rolling autosave — oldest slot evicted, quiet-boundary captures. */
async function runAutosave(): Promise<void> {
  try {
    const records = await saveStore.getAll();
    const target = pickAutosaveTarget(records);
    const bytes = await captureContainerForSave();
    await saveStore.put({
      name: target,
      savedAt: Date.now(),
      playtimeSeconds,
      saveBlob: new Blob([bytes as BlobPart]),
    });
    toast.show(`Autosaved → ${target}`);
  } catch (error) {
    console.warn("autosave skipped", error);
  }
}

let wallDragStart: { tileX: number; tileY: number } | null = null;

canvas.addEventListener("pointerdown", (event: PointerEvent) => {
  if (event.button !== 0) return;
  const candidate = currentPlacementCheck();
  if (
    candidate &&
    (candidate.defId === "palisade-wall" || candidate.defId === "stone-wall")
  ) {
    wallDragStart = { tileX: candidate.tileX, tileY: candidate.tileY };
  } else {
    wallDragStart = null;
  }
});

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
  if (
    wallDragStart &&
    candidate &&
    (candidate.defId === "palisade-wall" || candidate.defId === "stone-wall")
  ) {
    const run = traceWallRun(
      wallDragStart.tileX,
      wallDragStart.tileY,
      candidate.tileX,
      candidate.tileY,
    );
    for (const pt of run) {
      const check = validatePlacement(
        world,
        comps,
        candidate.defId,
        pt.x,
        pt.y,
        VIEWER,
      );
      if (check.ok) {
        issuePlaceBuilding(
          world.inbox,
          world.tick,
          candidate.defId,
          pt.x,
          pt.y,
        );
      }
    }
    buildMenu.disarm();
    wallDragStart = null;
    return;
  }
  wallDragStart = null;

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
  wallDragStart = null;
  if (buildMenu.armedDefId() === null) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  buildMenu.disarm();
});

function relicAt(worldX: number, worldY: number): number | undefined {
  if (!comps.relicId) return undefined;
  const relics = relicsOf(world, comps);
  const posRows = world.rowsByComponentId.get(comps.positionId);
  if (!posRows) return undefined;
  for (const { eid, row } of relics) {
    if (row.state !== RELIC_GROUND) continue;
    const pos = posRows.get(eid);
    if (!pos) continue;
    const dx = pos[0]! - worldX;
    const dy = pos[1]! - worldY;
    if (dx * dx + dy * dy <= 1.5 * 1.5) {
      return eid;
    }
  }
  return undefined;
}

function isUnitCarryingRelic(unitEid: number): boolean {
  if (!comps.relicId) return false;
  const relics = relicsOf(world, comps);
  for (const { row } of relics) {
    if (row.state === RELIC_CARRIED && row.holderEid === unitEid) {
      return true;
    }
  }
  return false;
}

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
  relicAt: (x, y) => relicAt(x, y),
  monasteryAt: (x, y) => {
    const eid = buildingAt(x, y);
    if (eid === undefined) return undefined;
    const row = getBuildingRow(world, comps, eid);
    if (!row || row[0] !== VIEWER) return undefined;
    const bDef = buildingDefOf(buildingIdOfCode(row[1]!));
    return bDef.id === "monastery" ? eid : undefined;
  },
  isCarryingRelic: (unitEid) => isUnitCarryingRelic(unitEid),
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
    if (attackMoveArmed) {
      disarmAttackMove();
      return;
    }
    if (!matchDecidedShown) pauseMenu.toggle();
    return;
  }
  if (pauseMenu.isOpen) return; // paused chrome swallows gameplay keys
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

// Victory-path progress panel (M4-T4, §2.11): per-path sustained metric
// vs threshold plus timer state, fed from the same digest-row derivation
// the evaluator decides on.
const victoryPathsPanel = createVictoryPathsPanel();

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

// Building visuals (instanced 3D GLTF models per def/age-stage) fed from the pure
// building-snapshot mirror, plus the single-building selection panel.
let buildingModelsLayer: BuildingModelsLayer | undefined;
let relicModelsLayer: RelicModelsLayer | undefined;
let resourceModelsLayer: ResourceModelsLayer | undefined;
let relicReuseFrame: RelicSnapshotFrame | undefined;
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
    const trainableUnits = def.trainQueue.trainable.map((t) => {
      const uDef = unitDefOf(t.unitId);
      const costStr = Object.entries(uDef.costs)
        .filter(([, amt]) => amt > 0)
        .map(([res, amt]) => `${String(amt)} ${res}`)
        .join(" · ");
      return {
        unitId: t.unitId,
        label: `Train ${uDef.name} (${costStr})`,
      };
    });
    return {
      title: def.name,
      buildingEid: eid,
      queue: readTrainQueue(world, comps, eid).map((entry) => ({
        label: unitDefOf(unitIdOfCode(entry.unitCode)).name,
        remainingTicks: entry.remainingTicks,
      })),
      pop: {
        current: populationOf(world, comps),
        cap: populationCapOf(world, comps),
      },
      canTrain: canEnqueueTraining(world, comps, eid),
      trainableUnits,
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

// Company oversight panel (M4-T2, §2.7): one block per chartered
// company — branches, ledger tail, share/freeze controls — plus a
// charter form whenever the selection holds seed-able workplaces. All
// data comes from the same Company/Branch/TreasuryDelta rows digests
// hash; actions ride the shared inbox as authoritative commands.
const formatCredits = (milli: number): string => (milli / 1000).toFixed(2);

/** True when `eid` is a live construction site (unfinished branch). */
const isSiteEid = (eid: number): boolean =>
  getBuildingRow(world, comps, eid) === undefined &&
  world.rowsByComponentId.get(comps.buildingSiteId)?.has(eid) === true;

/** One expansion-log entry as a legible public-history line. */
const expansionLogText = (
  entry: ExpansionLogEntry,
  logWorld: World,
  logComps: SimComponents,
): string => {
  switch (entry.kind) {
    case EXPANSION_LOG_EXECUTED:
      return `expanded to (${String(entry.argA)}, ${String(entry.argB)})`;
    case EXPANSION_LOG_APPROVED:
      return `approved expansion at (${String(entry.argA)}, ${String(entry.argB)})`;
    case EXPANSION_LOG_REJECTED:
      return "rejected a proposal";
    case EXPANSION_LOG_SEIZED:
      return `seized branch #${String(entry.argA)}`;
    case EXPANSION_LOG_FOUNDED: {
      const founder = popNameOf(logWorld, logComps, entry.argB) ?? "a Pop";
      return `${founder} founded it, absorbing ${String(entry.argA)}`;
    }
    default:
      return "…";
  }
};

/** Selected eids that could join a charter right now (finished, own,
 * §2.7-domain buildings not already branches). */
const charterableSelection = (): number[] => {
  const out: number[] = [];
  for (const eid of getSelectedEids()) {
    const row = getBuildingRow(world, comps, eid);
    if (!row || row[0] !== PLAYER_ONE) continue;
    if (domainOfBuildingDef(buildingIdOfCode(row[1]!)) === undefined) continue;
    if (branchRowOf(world, comps, eid) !== undefined) continue;
    out.push(eid);
  }
  return out;
};

const companyPanel = createCompanyPanel({
  currentTick: () => world.tick,
  inbox: world.inbox,
  selectedSeedBuildingIds: charterableSelection,
  getData: (): CompanyPanelData | undefined => {
    const companyRows = world.rowsByComponentId.get(comps.companyId);
    const branchRows = world.rowsByComponentId.get(comps.branchId);
    const companies: CompanyPanelEntry[] = [];
    if (companyRows) {
      for (const [eid] of [...companyRows].sort((a, b) => a[0] - b[0])) {
        const row = companyRowOf(world, comps, eid);
        if (!row) continue;
        const branches: CompanyPanelBranch[] = [];
        for (const [buildingEid, branchRow] of [...(branchRows ?? [])].sort(
          (a, b) => a[0] - b[0],
        )) {
          if (branchRow[0] !== eid) continue;
          const buildingRow = getBuildingRow(world, comps, buildingEid);
          const defLabel = buildingRow
            ? buildingDefOf(buildingIdOfCode(buildingRow[1]!)).name
            : undefined;
          const label =
            buildingRow !== undefined || isSiteEid(buildingEid)
              ? `${defLabel ?? "Site"} #${String(buildingEid)}`
              : `#${String(buildingEid)}`;
          const foremanEntry = foremanRowOf(world, comps, buildingEid);
          branches.push({
            buildingEid,
            label,
            foremanLabel:
              foremanEntry === undefined
                ? undefined
                : `Foreman ${popNameOf(world, comps, foremanEntry.foremanPopEid) ?? "??"}`,
          });
        }
        const origin = companyOriginOf(world, comps, eid);
        const pending = pendingExpansionOf(world, comps, eid);
        companies.push({
          companyId: eid,
          name: row.name,
          focusSlug: DOMAIN_NAMES[row.focusDomain] ?? "?",
          treasuryLabel: `${formatCredits(row.treasuryMilli)} cr`,
          sharePct: row.sharePct,
          frozen: row.frozen,
          approvalAuto:
            approvalModeOf(world, comps, eid) === APPROVAL_AUTO_APPROVE,
          branches,
          ledgerTail: treasuryDeltasOf(world, comps, eid)
            .slice()
            .reverse()
            .map((entry) => ({
              tick: entry.tick,
              credits: formatCredits(entry.milli),
            })),
          logTail: expansionLogOf(world, comps, eid)
            .slice()
            .reverse()
            .map((entry) => ({
              tick: entry.tick,
              text: expansionLogText(entry, world, comps),
            })),
          pending:
            pending === undefined
              ? undefined
              : {
                  defLabel: buildingDefOf(pending.defId).name,
                  tileX: pending.tileX,
                  tileY: pending.tileY,
                },
          organic:
            origin === undefined
              ? undefined
              : {
                  withinGraceWindow:
                    world.tick <=
                    origin.foundedTick + ORGANIC_DISSOLVE_GRACE_TICKS,
                },
        });
      }
    }
    const seeds = charterableSelection();
    const charterOffer =
      seeds.length > 0
        ? {
            focusSlugs: [...DOMAIN_NAMES],
            seedLabels: seeds.map((eid) => {
              const row = getBuildingRow(world, comps, eid)!;
              return `${buildingDefOf(buildingIdOfCode(row[1]!)).name} #${String(eid)}`;
            }),
          }
        : undefined;
    if (companies.length === 0 && charterOffer === undefined) return undefined;
    return { companies, charterOffer };
  },
  issueCharter: (payload: CharterPayload) => {
    world.inbox.submit({
      kind: "charterCompany",
      targetTick: world.tick + 1,
      data: {
        name: payload.name,
        focus: payload.focusDomain,
        seedBuildingIds: [...payload.seedBuildingIds],
      },
    });
  },
  issueShare: ({ companyId, sharePct }) => {
    world.inbox.submit({
      kind: "setCompanyShare",
      targetTick: world.tick + 1,
      data: { companyId, sharePct },
    });
  },
  issueFrozen: ({ companyId, frozen }) => {
    world.inbox.submit({
      kind: "setCompanyFrozen",
      targetTick: world.tick + 1,
      data: { companyId, frozen },
    });
  },
  issueApprovalMode: ({ companyId, auto }) => {
    world.inbox.submit({
      kind: "setApprovalMode",
      targetTick: world.tick + 1,
      data: { companyId, mode: auto ? APPROVAL_AUTO_APPROVE : 0 },
    });
  },
  issueVerdict: ({ companyId, approve }) => {
    world.inbox.submit({
      kind: approve ? "approveExpansion" : "rejectExpansion",
      targetTick: world.tick + 1,
      data: { companyId },
    });
  },
  issueSeize: ({ companyId, branchId }) => {
    world.inbox.submit({
      kind: "seizeBranch",
      targetTick: world.tick + 1,
      data: { companyId, branchId },
    });
  },
  issueDissolve: ({ companyId }) => {
    world.inbox.submit({
      kind: "dissolveCompany",
      targetTick: world.tick + 1,
      data: { companyId },
    });
  },
});

// Company news toasts (M4-T3): the ExpansionLog rows are public
// history, so new entries surface as transient notifications — organic
// foundings included (SPEC §2.7 origins "notification").
const seenCompanyLogEntries = new Map<number, number>();
const companyNewsToasts = (): void => {
  const companyRows = world.rowsByComponentId.get(comps.companyId);
  if (!companyRows) return;
  for (const [eid] of [...companyRows].sort((a, b) => a[0] - b[0])) {
    const row = companyRowOf(world, comps, eid);
    if (!row) continue;
    const seen = seenCompanyLogEntries.get(eid) ?? 0;
    const log = expansionLogOf(world, comps, eid);
    if (log.length < seen) {
      seenCompanyLogEntries.set(eid, log.length);
      continue;
    }
    for (const entry of log.slice(seen)) {
      const origin = companyOriginOf(world, comps, eid);
      toast.show(
        origin !== undefined && entry.kind === EXPANSION_LOG_FOUNDED
          ? `${row.name}: ${expansionLogText(entry, world, comps)}`
          : `${row.name} — ${expansionLogText(entry, world, comps)}`,
      );
    }
    seenCompanyLogEntries.set(eid, log.length);
  }
};

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
  unitLayers: readonly (UnitSpriteLayer | undefined)[],
): void {
  requestAnimationFrame((next) => frame(next, unitLayers));
  const frameMs = Math.min(now - lastFrame, FRAME_CLAMP_MS);
  lastFrame = now;
  const paused = pauseMenu.isOpen;
  if (!paused) {
    spriteTimeSec += frameMs / 1000;
    accumulator += frameMs;
    playtimeSeconds += frameMs / 1000;
  }

  let steps = 0;
  while (!paused && accumulator >= TICK_DT_MS && steps < MAX_STEPS_PER_FRAME) {
    advanceOneTick(); // may hold a tick internally on a late path response
    steps += 1;
    accumulator -= TICK_DT_MS;
  }
  if (steps === MAX_STEPS_PER_FRAME && accumulator > TICK_DT_MS) {
    accumulator = 0; // shed backlog rather than death-spiral catching up
  }

  // Rolling autosave (M5-T2): every ~2 sim-minutes of unpaused play.
  if (!paused && world.tick >= nextAutosaveAtTick) {
    nextAutosaveAtTick = world.tick + AUTOSAVE_INTERVAL_TICKS;
    void runAutosave();
  }

  // Snapshot AFTER stepping, interpolate BETWEEN the last two ticks.
  staging = captureSimSnapshot(world, comps, { reusable: staging });
  buildingFrame = captureBuildingSnapshot(world, comps, {
    reusable: buildingFrame,
  });

  // Audio (M5-T1): poll new sim event rows → intents; ambient by clock;
  // drain through the capped voice pool. Render-side only — sim untouched.
  voicePool.beginFrame();
  if (world.tick !== lastAudioTick) {
    const since = lastAudioTick < 0 ? world.tick : lastAudioTick;
    lastAudioTick = world.tick;
    for (const intent of collectAudioIntents(world, comps, PLAYER_ONE, since)) {
      audioScheduler.push(intent);
    }
    audioScheduler.ambient(minuteOfDay(world.tick), now);
  }
  audioScheduler.drain((batch) => voicePool.play(batch));

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

  // Issue #75: Time-of-day atmospheric sky & lighting rig
  const tint = sampleOut.lightTint!;
  const lum = Math.max(tint[0]!, tint[1]!, tint[2]!);

  scratchBackground.setRGB(
    baseBackground.r * (0.35 + 0.65 * tint[0]!),
    baseBackground.g * (0.38 + 0.62 * tint[1]!),
    baseBackground.b * (0.45 + 0.55 * tint[2]!),
  );
  scene.background = scratchBackground;

  // Sun orbit & color based on minute of the day (offset 7:00 AM)
  const currentMinute = minuteOfDay(world.tick);
  const sunAngle = ((currentMinute - 360) / 1440) * Math.PI * 2;
  const mapCenter = world.layers.size * 0.5;
  sun.position.set(
    mapCenter + Math.cos(sunAngle) * 60,
    65 + Math.sin(Math.max(0.15, (currentMinute > 300 && currentMinute < 1260 ? (currentMinute - 300) / 960 : 0.5) * Math.PI)) * 22,
    mapCenter + Math.sin(sunAngle) * 40,
  );
  sun.target.position.set(mapCenter, 0, mapCenter);

  if (currentMinute >= 300 && currentMinute < 480) {
    // Dawn / morning golden peach light
    const t = (currentMinute - 300) / 180;
    sun.color.setRGB(1.0, 0.88 + t * 0.12, 0.72 + t * 0.28);
  } else if (currentMinute >= 480 && currentMinute < 1080) {
    // Midday bright crisp daylight
    sun.color.setRGB(1.0, 0.98, 0.94);
  } else if (currentMinute >= 1080 && currentMinute < 1260) {
    // Sunset / twilight amber-orange
    const t = (currentMinute - 1080) / 180;
    sun.color.setRGB(1.0, 0.98 - t * 0.22, 0.94 - t * 0.45);
  } else {
    // Moonlit slate-cyan night
    sun.color.setRGB(0.72, 0.82, 0.96);
  }

  // Raised night floor so terrain and units are crisp, readable navy
  sun.intensity = BASE_SUN_INTENSITY * (0.42 + 0.58 * lum);
  hemisphereLight.intensity = BASE_HEMI_INTENSITY * (0.50 + 0.50 * lum);
  hemisphereLight.color.setRGB(0.68 + 0.32 * tint[0]!, 0.74 + 0.26 * tint[1]!, 0.85 + 0.15 * tint[2]!);
  hemisphereLight.groundColor.setRGB(0.24 + 0.25 * tint[0]!, 0.26 + 0.22 * tint[1]!, 0.28 + 0.20 * tint[2]!);

  // Advance terrain animated shaders (water shimmer)
  (terrain as any).uTime.value = now * 0.001;

  for (let c = 0; c < layerScratches.length; c++) {
    layerScratches[c]!.count = 0;
  }

  for (let i = 0; i < sampledCount; i++) {
    const x = sampleOut.positions[i * 2]!;
    const y = sampleOut.positions[i * 2 + 1]!;
    const seen =
      sampledCount > 0 && fog.isVisible(Math.floor(x), Math.floor(y), VIEWER);
    barHpFractions[i] = seen ? sampleOut.hpFractions[i]! : 1;
    if (!seen) continue;

    const defCode = sampleOut.defCodes ? sampleOut.defCodes[i]! : 8;
    const bucket = layerScratches[defCode];
    if (!bucket || bucket.count >= RENDER_CAPACITY) continue;

    const idx = bucket.count;
    bucket.positions[idx * 2] = x;
    bucket.positions[idx * 2 + 1] = y;
    bucket.headings[idx] = sampleOut.headings[i]!;

    const actCode = sampleOut.activityCodes ? sampleOut.activityCodes[i]! : 0;
    bucket.actionSlots[idx] = slotLookup[defCode]?.[actCode] ?? 0;

    const ownerId = sampleOut.ownerIds ? sampleOut.ownerIds[i]! : 0;
    const o3 = idx * 3;
    if (ownerId === VIEWER) {
      bucket.tints[o3] = 1.0;
      bucket.tints[o3 + 1] = 1.0;
      bucket.tints[o3 + 2] = 1.0;
    } else {
      bucket.tints[o3] = 1.25;
      bucket.tints[o3 + 1] = 0.65;
      bucket.tints[o3 + 2] = 0.65;
    }

    bucket.groundHeights[idx] = terrainHeightAt(world.layers, x, y);
    bucket.count++;
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

  // §7 LOD zoom bands: the sprite shader's playback quantum derives
  // from live zoom — near band 15 fps, far band (>60% zoom-out) 7.5.
  currentPlaybackFps = playbackRateForZoom(
    cameraRig.viewHeight,
    MIN_VIEW_HEIGHT,
    MAX_VIEW_HEIGHT,
  );

  for (let defCode = 0; defCode < unitLayers.length; defCode++) {
    const layer = unitLayers[defCode];
    if (!layer) continue;
    const bucket = layerScratches[defCode]!;
    if (bucket.count > 0) {
      layer.mesh.visible = true;
      layer.setTime(spriteTimeSec);
      layer.setPlaybackRate(currentPlaybackFps);
      layer.writeInstances(
        {
          positions: bucket.positions,
          headings: bucket.headings,
          actionSlots: bucket.actionSlots,
          tints: bucket.tints,
          count: bucket.count,
        },
        bucket.groundHeights,
        cameraRig.azimuthRad,
      );
    } else {
      layer.mesh.visible = false;
    }
  }

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
    bDefCodes[bCount] = buildingFrame.defCodes[i]!;
    bOwnerIds[bCount] = buildingFrame.ownerIds[i]!;
    bAgeRanks[bCount] = buildingFrame.ageRanks[i]!;
    bGhosts[bCount] = ghost ? 1 : 0;
    bCount += 1;
  }
  if (buildingModelsLayer) {
    buildingModelsLayer.write(
      {
        count: bCount,
        eids: bEids,
        origins: bOrigins,
        sizes: bSizes,
        states: bStates,
        progress: bProgress,
        defCodes: bDefCodes,
        ownerIds: bOwnerIds,
        ageRanks: bAgeRanks,
      },
      world.layers,
      {
        isGhost: (index) => bGhosts[index] === 1,
        viewerId: VIEWER,
      },
    );
  }

  if (relicModelsLayer) {
    relicReuseFrame = captureRelicSnapshot(world, comps, {
      reusable: relicReuseFrame,
    });
    relicModelsLayer.write(relicReuseFrame, world.layers, {
      fog: {
        isVisible: (x, y) => fog.isVisible(x, y, VIEWER),
        isExplored: (x, y) => fog.isExplored(x, y, VIEWER),
      },
    });
  }

  if (resourceModelsLayer) {
    resourceModelsLayer.uTime.value = now * 0.001;
    const nodeRows = world.rowsByComponentId.get(comps.resourceNodeId);
    const posRows = world.rowsByComponentId.get(comps.positionId);
    if (nodeRows && posRows) {
      resourceModelsLayer.write(nodeRows as any, posRows as any, world.layers, {
        fog: {
          isVisible: (x, y) => fog.isVisible(x, y, VIEWER),
          isExplored: (x, y) => fog.isExplored(x, y, VIEWER),
        },
      });
    }
  }

  // Update farm furrows on terrain
  const buildingRows = world.rowsByComponentId.get(comps.buildingId);
  const posRows = world.rowsByComponentId.get(comps.positionId);
  const farmTiles: Array<{ x: number; y: number; width: number; height: number }> = [];
  if (buildingRows && posRows) {
    for (const [eid, bRow] of buildingRows) {
      if (bRow[1] === 5) {
        const p = posRows.get(eid);
        if (p) farmTiles.push({ x: Math.floor(p[0]!), y: Math.floor(p[1]!), width: 3, height: 3 });
      }
    }
  }
  terrain.updateFarms(farmTiles);

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
  // M4-T6: disclose the AI difficulty knobs — decision interval,
  // reaction latency and hard's documented income multiplier.
  topbar.updateDifficulty(session.aiDifficulty);
  victoryPathsPanel.update(victoryPathReadouts(world, comps, VIEWER));
  controlGroups.refreshChips();
  buildMenu.refresh();
  buildingPanel.refresh();
  popCard.refresh();
  domainPanel.refresh();
  companyPanel.refresh();
  companyNewsToasts();
  pollMatchOutcome();
  renderer.render(scene, cameraRig.camera);

  // SPEC §7 draw-call budget: terrain + instanced sprite field +
  // buildings + EXACTLY TWO overlay draws (selection rings + health
  // bars) must stay in the single digits. Logged every frame; the
  // dev HUD line (renderer.info draw calls/triangles live, M5-T4)
  // makes the ≤150 @500-instance audit visible in-browser — manual
  // pass documented in docs/m5-manual.md.
  const calls = renderer.info.render.calls;
  console.assert(calls <= 150, `draw calls ${calls} exceed §7 budget`);
  devStats?.update(calls, renderer.info.render.triangles, currentPlaybackFps);
}

Promise.all([
  loadUnitLayers(),
  createBuildingModelsLayer(),
  createRelicModelsLayer(),
  createResourceModelsLayer(),
])
  .then(([unitLayers, bLayer, rLayer, resLayer]) => {
    for (const layer of unitLayers) {
      if (layer) scene.add(layer.mesh);
    }
    buildingModelsLayer = bLayer;
    scene.add(buildingModelsLayer.group);
    relicModelsLayer = rLayer;
    scene.add(relicModelsLayer.group);
    resourceModelsLayer = resLayer;
    scene.add(resourceModelsLayer.group);
    requestAnimationFrame((now) => frame(now, unitLayers));
  })
  .catch((error: unknown) => {
    console.error("unit atlases, buildings, relics or resources failed to load", error);
    document.body.textContent =
      "Failed to load unit atlases or models — check assets.";
  });

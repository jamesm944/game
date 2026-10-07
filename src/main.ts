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

declare global {
  interface Window {
    __game?: Record<string, unknown>;
  }
}

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
import { createRallyFlagLayer } from "./render/rallyFlag";
import { createWaypointLayer } from "./render/waypointLine";
import { createChimneySmokeLayer } from "./render/chimneySmoke";
import { createAgeUpBanner, formatAgeToast } from "./ui/ageUpBanner";
import { createToastManager } from "./ui/toasts";
import { extractWaypointChain } from "./sim/activities";
import {
  getAssignedSite,
  getBuildingRow,
  getBuildingSiteRow,
  getPosition,
  populationCapOf,
  populationOf,
  readActivityQueue,
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
  techDefOf,
  techIdOfCode,
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
import { activeTradeCartsCountForMarket } from "./sim/systems/market";
import { currentAgeRankOf, isDefAgeUnlocked } from "./sim/systems/age";
import {
  canAfford,
  validatePlacement,
  stampFinishedBuilding,
  traceWallRun,
} from "./sim/systems/placement";
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
  createShipModelsLayer,
  NAVAL_UNIT_IDS,
  type ShipModelsLayer,
} from "./render/shipModels";
import { captureRelicSnapshot, type RelicSnapshotFrame } from "./sim/mirror";
import { relicsOf, RELIC_GROUND, RELIC_CARRIED } from "./sim/components/relic";
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
import { playerTintOf } from "./render/playerColors";
import {
  PLAYBACK_QUANTUM_FPS,
  playbackRateForZoom,
} from "./render/atlasFrames";
import { createHealthBars } from "./render/healthBars";
import {
  createCastBars,
  CAST_BAR_CAPACITY,
  CAST_BAR_LIFT,
} from "./render/castBars";
import {
  createConversionRings,
  CONVERSION_RING_CAPACITY,
} from "./render/conversionRings";
import {
  HEALTH_BAR_CAPACITY,
  packHealthBarAttributes,
  type HealthBarAttributeArrays,
} from "./render/overlayPack";
import {
  createPostProcessingPipeline,
  type PostProcessingPipeline,
} from "./render/postProcessing";
import {
  issueAttackMove,
  issueGather,
  issueGuard,
  issuePatrol,
  issueSetStance,
  issueStop,
  issuePack,
  issueUnpack,
} from "./ui/orders";
import {
  spawnCombatUnit,
  readCombatEvents,
  researchedTechCodesOf,
  COMBAT_EVENT_DAMAGE,
} from "./sim/components/combat";
import { RESOURCE_WOOD } from "./sim/components/economy";
import {
  isAutoReseedEnabled,
  readFarmDepletedEvents,
} from "./sim/systems/gather";
import {
  issuePlaceBuilding,
  snapGhostOrigin,
  wireBuildMenu,
} from "./ui/buildMenu";
import { createBuildingPanel } from "./ui/buildingPanel";

import { createUnitPanel, type SelectedUnitSummary } from "./ui/unitPanel";
import {
  createCommandPanel,
  nextStance,
  formatStanceLabel,
  type UnitStance,
} from "./ui/commandPanel";
import { deriveUnitStats } from "./sim/combat/stats";
import { getCivBonuses } from "./sim/core/civilization";
import { givenNameOf } from "./sim/components/pop";
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
import {
  createTopbar,
  formatStockpileLine,
  type IdleWorkerBadgeCallbacks,
} from "./ui/hud";
import {
  findIdleVillagers,
  smartRedistributeIdleWorkers,
  formatRedistributionMessage,
} from "./sim/economy/idleWorkers";
import {
  aggregateBuildingSelection,
  dispatchBalancedTraining,
} from "./sim/economy/multiQueue";
import { victoryPathReadouts } from "./sim/systems/victory";
import { createVictoryPathsPanel } from "./ui/victoryPaths";
import { createToastHost } from "./ui/toast";
import { sanitizeSlotName, createPauseMenu } from "./ui/pauseMenu";
import {
  consumeDifficulty,
  consumeStrategy,
  createSettingsPanel,
  formatAutosaveInterval,
  persistVolume,
  readStoredGraphicsQuality,
  readStoredStrategy,
  readStoredVolumes,
  stashDifficulty,
  stashGraphicsQuality,
  stashStrategy,
  type BusVolumeName,
  type GraphicsQuality,
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
import { getGarrisonCount } from "./sim/components/garrison";

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
const chosenStrategy = consumeStrategy(window.localStorage);
/**
 * Mirror/overlay sample capacity: sized past the dev start population
 * so M2-T6 trained armies render without re-allocating the frame loop's
 * scratch arrays.
 */
const RENDER_CAPACITY = 512;
/** SPEC §7 loop safety: clamp + max-steps-per-frame cap. */
const FRAME_CLAMP_MS = 250;
const MAX_STEPS_PER_FRAME = 5;

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
      aiStrategy: chosenStrategy,
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
      aiStrategy: chosenStrategy,
      spawnRelics: true,
    });
  }
} else {
  session = createSkirmishWorld(bootSeed, {
    createTransport: () => createWorkerTransport(createPathWorkerFactory()),
    replay: recorder,
    aiDifficulty: chosenDifficulty,
    aiStrategy: chosenStrategy,
    spawnRelics: true,
  });
}
recorder?.beginPlay();
const { world, comps, fog } = session;

if (typeof window !== "undefined") {
  window.__game = {
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
    stampFinishedBuilding: (
      defId: string,
      x: number,
      y: number,
      options?: { playerId?: number },
    ) => {
      return stampFinishedBuilding(
        world,
        comps,
        defId,
        x,
        y,
        options ?? { playerId: PLAYER_ONE },
      );
    },
    unitCodeOf,
    unitDefOf,
    validatePlacement: (defId: string, x: number, y: number) => {
      return validatePlacement(world, comps, defId, x, y, PLAYER_ONE);
    },
    setSelection: (eids: number[]) => setSelection(eids),
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
sun.position.set(
  world.layers.size * 0.5 + 40,
  75,
  world.layers.size * 0.5 + 25,
);
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
sun.shadow.bias = 0.0005;
scene.add(sun);
if (typeof window !== "undefined" && window.__game) {
  window.__game.scene = scene;
  window.__game.renderer = renderer;
  window.__game.sun = sun;
}

// Graphics quality & post-processing pipeline (P1 / #130)
let currentGraphicsQuality: GraphicsQuality = readStoredGraphicsQuality(
  window.localStorage,
);
let postProcessing: PostProcessingPipeline | undefined =
  currentGraphicsQuality === "high"
    ? createPostProcessingPipeline(window.innerWidth, window.innerHeight)
    : undefined;
if (currentGraphicsQuality === "low") {
  renderer.shadowMap.enabled = false;
}

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
    if (r[0] === PLAYER_ONE && buildingIdOfCode(r[1]!) === "town-center") {
      const p = startPosRows.get(eid);
      if (p && p[0] !== undefined && p[1] !== undefined) {
        startCamX = p[0];
        startCamY = p[1];
        break;
      }
    }
  }
}
cameraRig.setCenter(startCamX, startCamY);
if (typeof window !== "undefined" && window.__game) {
  window.__game.cameraRig = cameraRig;
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
  "man-at-arms": {
    png: manAtArmsPng,
    json: manAtArmsJson,
    width: 0.95,
    height: 1.5,
  },
  longswordsman: {
    png: manAtArmsPng,
    json: manAtArmsJson,
    width: 1.0,
    height: 1.55,
  },
  "two-handed-swordsman": {
    png: manAtArmsPng,
    json: manAtArmsJson,
    width: 1.05,
    height: 1.6,
  },
  "scout-cavalry": {
    png: scoutCavalryPng,
    json: scoutCavalryJson,
    width: 1.3,
    height: 1.7,
  },
  "light-cavalry": {
    png: scoutCavalryPng,
    json: scoutCavalryJson,
    width: 1.35,
    height: 1.75,
  },
  knight: { png: knightPng, json: knightJson, width: 1.3, height: 1.7 },
  cavalier: { png: knightPng, json: knightJson, width: 1.35, height: 1.75 },
  paladin: { png: knightPng, json: knightJson, width: 1.4, height: 1.8 },
  archer: { png: archerPng, json: archerJson, width: 0.95, height: 1.5 },
  arbalest: { png: archerPng, json: archerJson, width: 1.0, height: 1.55 },
  skirmisher: {
    png: skirmisherPng,
    json: skirmisherJson,
    width: 0.95,
    height: 1.5,
  },
  monk: { png: monkPng, json: monkJson, width: 0.95, height: 1.5 },
  "trade-cart": {
    png: scoutCavalryPng,
    json: scoutCavalryJson,
    width: 1.3,
    height: 1.6,
  },
  "battering-ram": {
    png: scoutCavalryPng,
    json: scoutCavalryJson,
    width: 1.5,
    height: 1.7,
  },
  mangonel: {
    png: skirmisherPng,
    json: skirmisherJson,
    width: 1.4,
    height: 1.6,
  },
  "trebuchet-packed": {
    png: scoutCavalryPng,
    json: scoutCavalryJson,
    width: 1.4,
    height: 1.7,
  },
  trebuchet: {
    png: monkPng,
    json: monkJson,
    width: 1.6,
    height: 2.0,
  },
  longbowman: {
    png: archerPng,
    json: archerJson,
    width: 1.0,
    height: 1.6,
  },
  "throwing-axeman": {
    png: manAtArmsPng,
    json: manAtArmsJson,
    width: 1.05,
    height: 1.55,
  },
  huskarl: {
    png: manAtArmsPng,
    json: manAtArmsJson,
    width: 1.1,
    height: 1.6,
  },
  cataphract: {
    png: knightPng,
    json: knightJson,
    width: 1.45,
    height: 1.85,
  },
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
const deathSlotsByCode: number[] = new Array(32).fill(0);

interface RenderCorpse {
  x: number;
  y: number;
  heading: number;
  defCode: number;
  deathSlot: number;
  tint: [number, number, number];
  startSec: number;
  expireSec: number;
}
const activeCorpses: RenderCorpse[] = [];
const hitFlashTimers = new Map<number, number>();
const lastUnitHp = new Map<number, number>();
const lastUnitInfo = new Map<
  number,
  { x: number; y: number; heading: number; defCode: number; ownerId: number }
>();

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
  const layersByCode: Array<UnitSpriteLayer | undefined> = new Array(32).fill(
    undefined,
  );

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
    const defaultIdle =
      layer.atlas.actions.find((a) => a.name === "idle")?.slot ?? 0;
    const deathAction = layer.atlas.actions.find((a) => a.name === "death");
    deathSlotsByCode[code] = deathAction ? deathAction.slot : defaultIdle;

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

/** Buildings/sites whose footprints intersect an axis-aligned world rect. */
const buildingsInRect = (
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): number[] => {
  const result: number[] = [];
  for (let i = world.entities.length - 1; i >= 0; i--) {
    const eid = world.entities[i]!;
    const rect =
      siteRectOf(world, comps, eid) ?? buildingRectOf(world, comps, eid);
    if (!rect) continue;
    const bMinX = rect.x;
    const bMaxX = rect.x + rect.width;
    const bMinY = rect.y;
    const bMaxY = rect.y + rect.height;
    if (minX <= bMaxX && maxX >= bMinX && minY <= bMaxY && maxY >= bMinY) {
      result.push(eid);
    }
  }
  return result;
};

wireSelectionInput({
  canvas,
  groundPointAt: groundAt,
  getFrame: () => staging ?? null,
  worldPerPixel,
  isOnScreen,
  buildingAt,
  buildingsInRect,
  isPlacementArmed: () => buildMenu.armedDefId() !== null,
});

// Green ring feedback pool + orders log; the marker spawns synchronously
// inside the right-click handler → visible the same rendered frame.
const moveMarkers = createRingMarkerPool({ scene, layers: world.layers });
const rallyFlagLayer = createRallyFlagLayer(scene, world.layers);
const waypointLayer = createWaypointLayer(scene, world.layers);
const chimneySmokeLayer = createChimneySmokeLayer(scene);
const ageUpBanner = createAgeUpBanner();
const toastManager = createToastManager({
  onJumpTo: (x, y) => {
    cameraRig.setCenter(x, y);
    // If an idle villager is near (x, y), select them and play audio feedback
    const idleEids = findIdleVillagers(world, comps, PLAYER_ONE);
    const posRows = world.rowsByComponentId.get(comps.positionId);
    let nearestEid: number | undefined;
    let nearestDistSq = Infinity;
    for (const eid of idleEids) {
      const pos = posRows?.get(eid);
      if (!pos) continue;
      const dx = pos[0]! - x;
      const dy = pos[1]! - y;
      const distSq = dx * dx + dy * dy;
      if (distSq < nearestDistSq && distSq <= 25) {
        nearestDistSq = distSq;
        nearestEid = eid;
      }
    }
    if (nearestEid !== undefined) {
      setSelection([nearestEid]);
      audioScheduler.push({ clip: "ui.idle", priority: 8 });
    }
  },
});
let lastPlayerAgeRank = currentAgeRankOf(world, comps, PLAYER_ONE);
let lastIdleVillagerCount = 0;
let lastIdleVillagerAlertTime = 0;
const IDLE_VILLAGER_ALERT_COOLDOWN_MS = 6000;
const knownTechCodes = new Set<number>(
  researchedTechCodesOf(world, comps, PLAYER_ONE),
);
let chimneySinceUpdateMs = 1000; // trigger immediate populate

function collectChimneyCoords(): { x: number; y: number; height: number }[] {
  const coords: { x: number; y: number; height: number }[] = [];
  const bRows = world.rowsByComponentId.get(comps.buildingId);
  const posRows = world.rowsByComponentId.get(comps.positionId);
  if (!bRows || !posRows) return coords;

  for (const [eid, bRow] of bRows) {
    if (getBuildingSiteRow(world, comps, eid)) continue;
    const def = buildingDefOf(buildingIdOfCode(bRow[1]!));
    const pos = posRows.get(eid);
    if (!pos) continue;

    if (
      def.id.startsWith("house") ||
      def.id.startsWith("tc") ||
      def.id === "town-center" ||
      def.id === "blacksmith" ||
      def.id === "forge" ||
      def.id === "smithy"
    ) {
      const h =
        def.id.startsWith("tc") || def.id === "town-center"
          ? 3.2
          : def.id === "blacksmith" || def.id === "forge"
            ? 2.5
            : 1.8;
      coords.push({
        x: pos[0]! + def.footprint.width * 0.5 - 0.2,
        y: pos[1]! + def.footprint.height * 0.5 - 0.2,
        height: h,
      });
    }
  }
  return coords;
}

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
    const buildingRow = world.rowsByComponentId.get(comps.buildingId)?.get(eid);
    if (buildingRow) {
      const def = buildingDefOf(buildingIdOfCode(buildingRow[1]!));
      const ox = buildingRow[2]!;
      const oy = buildingRow[3]!;
      if (
        tx >= ox &&
        tx < ox + def.footprint.width &&
        ty >= oy &&
        ty < oy + def.footprint.height
      ) {
        return eid;
      }
      continue;
    }
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
  strategy: readStoredStrategy(window.localStorage),
  onSetVolume: (name: BusVolumeName, value: number) => {
    const buses = audioBusesHolder.current;
    if (buses) setBusVolume(buses, name, value);
    else persistVolume(window.localStorage, name, value);
  },
  onSetDifficulty: (id) => {
    stashDifficulty(window.localStorage, id);
    toast.show(`AI ${id} — applies to the next match`);
  },
  onSetStrategy: (strategy) => {
    stashStrategy(window.localStorage, strategy);
    toast.show(`AI strategy: ${strategy} — applies to the next match`);
  },
  onPreviewSound: (clip) => {
    audioScheduler.push({ clip, priority: 2 });
  },
  graphicsQuality: currentGraphicsQuality,
  onSetGraphicsQuality: (q) => {
    currentGraphicsQuality = q;
    stashGraphicsQuality(window.localStorage, q);
    if (q === "high") {
      renderer.shadowMap.enabled = true;
      if (!postProcessing) {
        postProcessing = createPostProcessingPipeline(
          window.innerWidth,
          window.innerHeight,
        );
      }
    } else {
      if (postProcessing) {
        postProcessing.dispose();
        postProcessing = undefined;
      }
      if (q === "low") {
        renderer.shadowMap.enabled = false;
      } else {
        renderer.shadowMap.enabled = true;
      }
    }
    toast.show(`Graphics: ${q}`);
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
        event.shiftKey,
      );
      moveMarkers.spawn(ground.x, ground.y); // same-frame feedback
    }
    return;
  }
  if (patrolArmed) {
    patrolArmed = false;
    const ground = groundAt(event.clientX, event.clientY);
    if (ground && selectionCount() > 0) {
      const selected = getSelectedEids();
      const firstPos = world.rowsByComponentId
        .get(comps.positionId)
        ?.get(selected[0]!);
      const startX = firstPos ? firstPos[0]! : ground.x;
      const startY = firstPos ? firstPos[1]! : ground.y;
      issuePatrol(
        world.inbox,
        world.tick,
        selected,
        [
          { x: startX, y: startY },
          { x: ground.x, y: ground.y },
        ],
        event.shiftKey,
      );
      moveMarkers.spawn(ground.x, ground.y);
      toast.show("Patrol route set");
    }
    return;
  }
  if (guardArmed) {
    guardArmed = false;
    const ground = groundAt(event.clientX, event.clientY);
    if (ground && selectionCount() > 0) {
      let bestEid: number | undefined;
      let bestDistSq = 2.0 * 2.0;
      for (const eid of world.entities) {
        const pos = world.rowsByComponentId.get(comps.positionId)?.get(eid);
        if (!pos) continue;
        const dx = pos[0]! - ground.x;
        const dy = pos[1]! - ground.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDistSq) {
          bestDistSq = d2;
          bestEid = eid;
        }
      }
      if (bestEid !== undefined) {
        issueGuard(world.inbox, world.tick, getSelectedEids(), bestEid);
        toast.show("Guarding target");
      }
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
  marketAt: (x, y) => {
    const eid = buildingAt(x, y);
    if (eid === undefined) return undefined;
    const row = getBuildingRow(world, comps, eid);
    if (!row) return undefined;
    const bDef = buildingDefOf(buildingIdOfCode(row[1]!));
    return bDef.id === "market" ? eid : undefined;
  },
  isTradeCart: (unitEid) => {
    const combatRow = world.rowsByComponentId.get(comps.combatId)?.get(unitEid);
    if (!combatRow) return false;
    const def = unitDefOf(unitIdOfCode(combatRow[0]!));
    return def.id === "trade-cart";
  },
  isCarryingRelic: (unitEid) => isUnitCarryingRelic(unitEid),
  isProductionBuilding: (eid) => {
    const row = getBuildingRow(world, comps, eid);
    if (!row || row[0] !== VIEWER) return false;
    const def = buildingDefOf(buildingIdOfCode(row[1]!));
    return def.trainQueue !== undefined;
  },
  setRallyPoint: (bEid, rx, ry) => {
    const pos = world.rowsByComponentId.get(comps.positionId)?.get(bEid);
    const bx = pos ? pos[0]! : rx;
    const by = pos ? pos[1]! : ry;
    rallyFlagLayer.setRally(bEid, bx, by, rx, ry);
  },
  garrisonAt: (x, y) => {
    const eid = buildingAt(x, y);
    if (eid === undefined) return undefined;
    const row = getBuildingRow(world, comps, eid);
    if (!row || row[0] !== VIEWER) return undefined;
    const bDef = buildingDefOf(buildingIdOfCode(row[1]!));
    return (bDef.garrisonCapacity ?? 0) > 0 ? eid : undefined;
  },
  isMonk: (unitEid) => {
    const combatRow = world.rowsByComponentId.get(comps.combatId)?.get(unitEid);
    if (!combatRow) return false;
    const def = unitDefOf(unitIdOfCode(combatRow[0]!));
    return def.id === "monk" || (def.armorClasses?.includes("monk") ?? false);
  },
  enemyAt: (x, y) => {
    const posRows = world.rowsByComponentId.get(comps.positionId);
    const combatRows = world.rowsByComponentId.get(comps.combatId);
    if (!posRows || !combatRows) return undefined;
    let bestEid: number | undefined;
    let bestDistSq = 1.0;
    for (const [eid, cRow] of combatRows) {
      if (cRow[1] === VIEWER) continue;
      if (cRow[2]! <= 0) continue;
      const p = posRows.get(eid);
      if (!p) continue;
      const dx = p[0]! - x;
      const dy = p[1]! - y;
      const dSq = dx * dx + dy * dy;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestEid = eid;
      }
    }
    return bestEid;
  },
  onMoveOrdered: (x, y) => moveMarkers.spawn(x, y),
});

// ---- Attack-move (A) + stop (S) keyboard orders (M2-T6, §2.13) -----
//
// A arms the attack-move cursor: the next left-click issues attackMove
// at that ground point (red-ring feedback) instead of selecting. S
// stops the selection immediately. Escape or a right-click disarms.

let attackMoveArmed = false;
let patrolArmed = false;
let guardArmed = false;

function disarmAttackMove(): void {
  if (!attackMoveArmed && !patrolArmed && !guardArmed) return;
  attackMoveArmed = false;
  patrolArmed = false;
  guardArmed = false;
}

let currentStance: UnitStance = "aggressive";

function handleStopCommand(): void {
  issueStop(world.inbox, world.tick, getSelectedEids());
  toast.show("Stop");
}

function handleAttackMoveCommand(): void {
  attackMoveArmed = true;
  patrolArmed = false;
  guardArmed = false;
  toast.show("Attack-move — click a destination");
}

function handlePatrolCommand(): void {
  patrolArmed = true;
  attackMoveArmed = false;
  guardArmed = false;
  toast.show("Patrol — click destination waypoint");
}

function handleGuardCommand(): void {
  guardArmed = true;
  attackMoveArmed = false;
  patrolArmed = false;
  toast.show("Guard — click unit to guard");
}

function handleCycleStanceCommand(): void {
  currentStance = nextStance(currentStance);
  if (selectionCount() > 0) {
    issueSetStance(world.inbox, world.tick, getSelectedEids(), currentStance);
    commandPanel.update(true, currentStance, false);
  }
  toast.show(formatStanceLabel(currentStance));
}

function handleGarrisonCommand(): void {
  toast.show("Garrisoning units into nearest shelter...");
}

window.addEventListener("keydown", (event: KeyboardEvent) => {
  if (event.repeat || event.metaKey || event.ctrlKey) return;
  const key = event.key.toLowerCase();
  if (key === "escape") {
    if (attackMoveArmed || patrolArmed || guardArmed) {
      disarmAttackMove();
      return;
    }
    if (!matchDecidedShown) pauseMenu.toggle();
    return;
  }
  if (pauseMenu.isOpen) return; // paused chrome swallows gameplay keys

  // Idle worker management hotkeys (V15, #106) — available regardless of current selection
  if (event.key === "." || event.key === ">" || key === "i") {
    if (event.altKey) {
      handleRedistributeIdleWorkersCommand();
    } else if (event.shiftKey || event.key === ">") {
      handleSelectAllIdleWorkersCommand();
    } else {
      handleCycleIdleWorkerCommand();
    }
    return;
  }
  if (key === "r") {
    handleRedistributeIdleWorkersCommand();
    return;
  }

  if (selectionCount() === 0) return;
  if (key === "a") {
    handleAttackMoveCommand();
  } else if (key === "s") {
    handleStopCommand();
  } else if (key === "p") {
    handlePatrolCommand();
  } else if (key === "g") {
    handleGuardCommand();
  } else if (key === "z") {
    handleCycleStanceCommand();
  } else if (key === "t") {
    handleGarrisonCommand();
  }
});

const commandPanel = createCommandPanel({
  onStop: handleStopCommand,
  onAttackMove: handleAttackMoveCommand,
  onPatrol: handlePatrolCommand,
  onGuard: handleGuardCommand,
  onCycleStance: handleCycleStanceCommand,
  onGarrison: handleGarrisonCommand,
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
  getCameraCenter: () => cameraRig.center,
  getResourceNodes: () => {
    const nodes = world.rowsByComponentId.get(comps.resourceNodeId);
    const pos = world.rowsByComponentId.get(comps.positionId);
    if (!nodes || !pos) return [];
    const res: { x: number; y: number; resourceCode: number }[] = [];
    for (const [eid, row] of nodes) {
      if ((row[1] ?? 0) <= 0) continue;
      const p = pos.get(eid);
      if (!p) continue;
      res.push({ x: p[0]!, y: p[1]!, resourceCode: row[0] ?? 0 });
    }
    return res;
  },
  getBuildings: () => {
    if (!buildingFrame || buildingFrame.count === 0) return [];
    const b: {
      eid: number;
      x: number;
      y: number;
      width: number;
      height: number;
      ownerId: number;
    }[] = [];
    for (let i = 0; i < buildingFrame.count; i++) {
      b.push({
        eid: buildingFrame.eids[i]!,
        x: buildingFrame.origins[i * 2]!,
        y: buildingFrame.origins[i * 2 + 1]!,
        width: buildingFrame.sizes[i * 2]!,
        height: buildingFrame.sizes[i * 2 + 1]!,
        ownerId: buildingFrame.ownerIds[i]!,
      });
    }
    return b;
  },
  isOwnBuilding: (ownerId) => ownerId === VIEWER,
});

// ---- Idle worker management (V15, #106) — cycle & redistribute -------
//
// I cycles camera to the next idle villager and selects it so the player
// can manually re-task it. R smart-redistributes all idle workers at once
// using age-appropriate resource weights. The topbar badge shows the live
// idle count; clicking it cycles, the ⚡ button redistributes.

let idleCycleIndex = 0;

function handleCycleIdleWorkerCommand(): void {
  const idleEids = findIdleVillagers(world, comps);
  if (idleEids.length === 0) {
    toast.show("No idle villagers");
    return;
  }
  audioScheduler.push({ clip: "ui.idle", priority: 8 });
  idleCycleIndex = idleCycleIndex % idleEids.length;
  const eid = idleEids[idleCycleIndex]!;
  const currentNum = idleCycleIndex + 1;
  idleCycleIndex = (idleCycleIndex + 1) % idleEids.length;
  setSelection([eid]);
  const posRows = world.rowsByComponentId.get(comps.positionId);
  const pos = posRows?.get(eid);
  if (pos) {
    cameraRig.setCenter(pos[0]!, pos[1]!);
    minimap.ping(pos[0]!, pos[1]!, "#f59e0b", 1500);
  }
  toast.show(`Idle villager ${String(currentNum)}/${String(idleEids.length)}`);
}

function handleSelectAllIdleWorkersCommand(): void {
  const idleEids = findIdleVillagers(world, comps);
  if (idleEids.length === 0) {
    toast.show("No idle villagers");
    return;
  }
  audioScheduler.push({ clip: "ui.idle", priority: 8 });
  setSelection(idleEids);
  const posRows = world.rowsByComponentId.get(comps.positionId);
  const pos = posRows?.get(idleEids[0]!);
  if (pos) {
    cameraRig.setCenter(pos[0]!, pos[1]!);
    for (const eid of idleEids) {
      const p = posRows?.get(eid);
      if (p) minimap.ping(p[0]!, p[1]!, "#f59e0b", 1500);
    }
  }
  toast.show(
    `Selected all ${String(idleEids.length)} idle villager${idleEids.length === 1 ? "" : "s"}`,
  );
}

function handleRedistributeIdleWorkersCommand(): void {
  const result = smartRedistributeIdleWorkers(world, comps);
  toast.show(formatRedistributionMessage(result));
}

const idleCallbacks: IdleWorkerBadgeCallbacks = {
  onCycle: handleCycleIdleWorkerCommand,
  onSelectAll: handleSelectAllIdleWorkersCommand,
  onRedistribute: handleRedistributeIdleWorkersCommand,
};

const topbar = createTopbar(world.seed, idleCallbacks);

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
if (typeof window !== "undefined" && window.__game) {
  window.__game.victoryScreen = victoryScreen;
}

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
let shipModelsLayer: ShipModelsLayer | undefined;
let relicReuseFrame: RelicSnapshotFrame | undefined;
let buildingFrame = captureBuildingSnapshot(world, comps);

const buildingPanel = createBuildingPanel({
  currentTick: () => world.tick,
  inbox: world.inbox,
  onTrainUnit: (unitId, count, capableBuildingEids) => {
    const selected = getSelectedEids();
    const eids =
      capableBuildingEids && capableBuildingEids.length > 0
        ? capableBuildingEids
        : selected;
    dispatchBalancedTraining(
      world,
      comps,
      world.inbox,
      world.tick,
      eids,
      PLAYER_ONE,
      unitId,
      count,
    );
  },
  getData: () => {
    const selected = getSelectedEids();
    if (selected.length > 1) {
      const summary = aggregateBuildingSelection(
        world,
        comps,
        selected,
        PLAYER_ONE,
      );
      if (summary) {
        return {
          title: summary.title,
          buildingEids: summary.buildingEids,
          trainableUnits: summary.trainableUnits.map((u) => ({
            unitId: u.unitId,
            label: u.label,
            capableBuildingCount: u.capableBuildingCount,
            capableBuildingEids: u.capableBuildingEids,
          })),
          canTrain: summary.canTrain,
          pop: summary.pop,
          multiQueueSummary: summary.buildingQueues.map((bq) => ({
            buildingEid: bq.buildingEid,
            buildingName: bq.defName,
            queueCount: bq.queueLength,
            activeUnitName: bq.headUnitName,
            remainingTicks: bq.headRemainingTicks,
          })),
        };
      }
      return undefined;
    }
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
    const garrisonCap = def.garrisonCapacity ?? 0;
    const garrison =
      garrisonCap > 0 && comps.garrisonId !== undefined
        ? { count: getGarrisonCount(world, comps, eid), capacity: garrisonCap }
        : undefined;

    const isMillOrFarm = def.id === "mill" || def.id === "farm";
    const canAutoReseed = isMillOrFarm;
    const autoReseedEnabled = isMillOrFarm
      ? isAutoReseedEnabled(world, PLAYER_ONE)
      : undefined;
    const farmFoodRemaining =
      def.id === "farm" && comps.resourceNodeId !== undefined
        ? (world.rowsByComponentId.get(comps.resourceNodeId)?.get(eid)?.[1] ??
          0)
        : undefined;

    if (!def.trainQueue) {
      return {
        title: def.name,
        buildingEid: eid,
        pop: {
          current: populationOf(world, comps),
          cap: populationCapOf(world, comps),
        },
        garrison,
        canAutoReseed,
        autoReseedEnabled,
        farmFoodRemaining,
      };
    }
    const trainableUnits = def.trainQueue.trainable.map((t) => {
      const uDef = unitDefOf(t.unitId);
      const costStr = Object.entries(uDef.costs)
        .filter(([, amt]) => amt > 0)
        .map(([res, amt]) => `${String(amt)} ${res}`)
        .join(" · ");
      return {
        unitId: t.unitId,
        label: `Train ${uDef.name} (${costStr})`,
        capableBuildingCount: 1,
        capableBuildingEids: [eid],
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
      isMarket: def.id === "market",
      activeTradeCarts:
        def.id === "market"
          ? activeTradeCartsCountForMarket(world, eid)
          : undefined,
      garrison,
      canAutoReseed,
      autoReseedEnabled,
      farmFoodRemaining,
    };
  },
});

// Unit selection HUD panel (V13, #90)
const unitPanel = createUnitPanel({
  onFocusUnit: (eid) => {
    setSelection([eid]);
  },
  onFilterByType: (unitId) => {
    const matching: number[] = [];
    for (const eid of getSelectedEids()) {
      const combatRow = world.rowsByComponentId.get(comps.combatId)?.get(eid);
      if (combatRow && unitIdOfCode(combatRow[0]!) === unitId) {
        matching.push(eid);
      }
    }
    if (matching.length > 0) setSelection(matching);
  },
  onPackUnit: (eid) => {
    issuePack(world.inbox, world.tick, [eid]);
  },
  onUnpackUnit: (eid) => {
    issueUnpack(world.inbox, world.tick, [eid]);
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

// Conversion cast bars & mystic rings (V14 Issue #101)
const castBars = createCastBars(scene);
const castBarOrigins = new Float32Array(CAST_BAR_CAPACITY * 3);
const castBarProgress = new Float32Array(CAST_BAR_CAPACITY);

const conversionRings = createConversionRings(scene, world.layers);
const conversionRingPositions = new Float32Array(CONVERSION_RING_CAPACITY * 2);

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
  postProcessing?.setSize(window.innerWidth, window.innerHeight);
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

    // Event Toast Notifications (V14 / #104)
    try {
      for (const e of readCombatEvents(world, comps, PLAYER_ONE)) {
        if (e.tick <= since) continue;
        if (e.kind === COMBAT_EVENT_DAMAGE) {
          const victimPos = getPosition(world, comps, e.victimEid);
          if (victimPos) {
            toastManager.notifyUnderAttack(victimPos.x, victimPos.y);
            minimap.ping(victimPos.x, victimPos.y, "#ef4444", 2500);
          }
        }
      }
    } catch {
      /* minimal worlds */
    }

    const currentTechCodes = researchedTechCodesOf(world, comps, PLAYER_ONE);
    for (const code of currentTechCodes) {
      if (!knownTechCodes.has(code)) {
        knownTechCodes.add(code);
        const techId = techIdOfCode(code);
        const tDef = techDefOf(techId);
        if (tDef) {
          toastManager.notifyResearchComplete(tDef.name);
        }
      }
    }

    // Farm Depleted Toast Notifications (V15 / #105)
    try {
      for (const e of readFarmDepletedEvents(world, PLAYER_ONE)) {
        if (e.tick <= since) continue;
        const farmPos = getPosition(world, comps, e.farmEid);
        const x = farmPos?.x ?? e.farmX;
        const y = farmPos?.y ?? e.farmY;
        toastManager.notifyFarmExhausted(
          x,
          y,
          e.reason === "insufficient-wood"
            ? "Insufficient wood (60) to reseed farm"
            : "Auto-reseed disabled",
        );
        if (x !== undefined && y !== undefined) {
          minimap.ping(x, y, "#eab308", 2500);
        }
      }
    } catch {
      /* minimal worlds */
    }
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
    65 +
      Math.sin(
        Math.max(
          0.15,
          (currentMinute > 300 && currentMinute < 1260
            ? (currentMinute - 300) / 960
            : 0.5) * Math.PI,
        ),
      ) *
        22,
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
  hemisphereLight.intensity = BASE_HEMI_INTENSITY * (0.5 + 0.5 * lum);
  hemisphereLight.color.setRGB(
    0.68 + 0.32 * tint[0]!,
    0.74 + 0.26 * tint[1]!,
    0.85 + 0.15 * tint[2]!,
  );
  hemisphereLight.groundColor.setRGB(
    0.24 + 0.25 * tint[0]!,
    0.26 + 0.22 * tint[1]!,
    0.28 + 0.2 * tint[2]!,
  );

  // Advance terrain animated shaders (water waves, Fresnel reflections, foam & sun glints)
  terrain.uTime.value = now * 0.001;
  if (terrain.waterUniforms) {
    terrain.waterUniforms.uSunDir.value.copy(sun.position).normalize();
    terrain.waterUniforms.uSunColor.value.copy(sun.color);
    terrain.waterUniforms.uSkyColor.value.copy(hemisphereLight.color);
  }

  for (let c = 0; c < layerScratches.length; c++) {
    layerScratches[c]!.count = 0;
  }

  // Hit flash & unit death tracking
  const liveEidsThisFrame = new Set<number>();
  if (staging) {
    for (let i = 0; i < staging.count; i++) {
      const eid = staging.eids[i]!;
      liveEidsThisFrame.add(eid);
      const hp = staging.hpFractions[i]!;
      const prevHp = lastUnitHp.get(eid);
      if (prevHp !== undefined && hp < prevHp - 0.001) {
        hitFlashTimers.set(eid, 4); // 4 frames of bright white flash on damage
      }
      lastUnitHp.set(eid, hp);
      lastUnitInfo.set(eid, {
        x: staging.positions[i * 2]!,
        y: staging.positions[i * 2 + 1]!,
        heading: staging.headings[i]!,
        defCode: staging.defCodes ? staging.defCodes[i]! : 8,
        ownerId: staging.ownerIds ? staging.ownerIds[i]! : 0,
      });
    }
  }

  // Detect fallen units: transition into lingering corpses or sinking ships
  for (const [eid, info] of lastUnitInfo) {
    if (!liveEidsThisFrame.has(eid)) {
      const lastHp = lastUnitHp.get(eid) ?? 0;
      const unitId = unitIdOfCode(info.defCode);
      const isShip = (NAVAL_UNIT_IDS as readonly string[]).includes(unitId);
      if (isShip && shipModelsLayer) {
        shipModelsLayer.addSinkingShip(
          unitId,
          info.x,
          info.y,
          info.heading,
          info.ownerId,
          spriteTimeSec,
        );
      } else if (lastHp <= 0.25 || lastHp === 0) {
        const corpseTint = playerTintOf(info.ownerId);
        activeCorpses.push({
          x: info.x,
          y: info.y,
          heading: info.heading,
          defCode: info.defCode,
          deathSlot: deathSlotsByCode[info.defCode] ?? 0,
          tint: [corpseTint[0], corpseTint[1], corpseTint[2]],
          startSec: spriteTimeSec,
          expireSec: spriteTimeSec + 5.0, // 5s = 150 ticks
        });
      }
      lastUnitHp.delete(eid);
      lastUnitInfo.delete(eid);
      hitFlashTimers.delete(eid);
    }
  }

  if (shipModelsLayer) {
    shipModelsLayer.beginFrame();
  }

  for (let i = 0; i < sampledCount; i++) {
    const x = sampleOut.positions[i * 2]!;
    const y = sampleOut.positions[i * 2 + 1]!;
    const seen =
      sampledCount > 0 && fog.isVisible(Math.floor(x), Math.floor(y), VIEWER);
    barHpFractions[i] = seen ? sampleOut.hpFractions[i]! : 1;
    if (!seen) continue;

    const defCode = sampleOut.defCodes ? sampleOut.defCodes[i]! : 8;
    const unitId = unitIdOfCode(defCode);
    if ((NAVAL_UNIT_IDS as readonly string[]).includes(unitId)) {
      if (shipModelsLayer) {
        const eid = staging ? (staging.eids[i] ?? i) : i;
        const velRow = world.rowsByComponentId.get(comps.velocityId)?.get(eid);
        const speed = velRow ? (velRow[1] ?? 0) : 0;
        shipModelsLayer.addShip({
          eid,
          unitId,
          x,
          y,
          heading: sampleOut.headings[i]!,
          ownerId: sampleOut.ownerIds ? sampleOut.ownerIds[i]! : 0,
          speed,
        });
      }
      continue;
    }

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
    const eid = staging ? staging.eids[i] : undefined;
    const flashFrames = eid !== undefined ? (hitFlashTimers.get(eid) ?? 0) : 0;
    if (flashFrames > 0 && eid !== undefined) {
      hitFlashTimers.set(eid, flashFrames - 1);
      // Saturated bright white hit flash
      bucket.tints[o3] = 3.5;
      bucket.tints[o3 + 1] = 3.5;
      bucket.tints[o3 + 2] = 3.5;
    } else {
      const tint = playerTintOf(ownerId);
      bucket.tints[o3] = tint[0];
      bucket.tints[o3 + 1] = tint[1];
      bucket.tints[o3 + 2] = tint[2];
    }

    bucket.groundHeights[idx] = terrainHeightAt(world.layers, x, y);
    bucket.count++;
  }

  // Render active corpses with death collapse and smooth fade-out
  for (let c = activeCorpses.length - 1; c >= 0; c--) {
    const corpse = activeCorpses[c]!;
    if (spriteTimeSec >= corpse.expireSec) {
      activeCorpses.splice(c, 1);
      continue;
    }
    const bucket = layerScratches[corpse.defCode];
    if (!bucket || bucket.count >= RENDER_CAPACITY) continue;

    const seen = fog.isVisible(
      Math.floor(corpse.x),
      Math.floor(corpse.y),
      VIEWER,
    );
    if (!seen) continue;

    const idx = bucket.count;
    bucket.positions[idx * 2] = corpse.x;
    bucket.positions[idx * 2 + 1] = corpse.y;
    bucket.headings[idx] = corpse.heading;
    bucket.actionSlots[idx] = corpse.deathSlot;

    // Fade out during the last 1.0s before expiring
    const timeLeft = corpse.expireSec - spriteTimeSec;
    const fade = Math.min(1.0, Math.max(0.0, timeLeft / 1.0));
    const o3 = idx * 3;
    bucket.tints[o3] = corpse.tint[0] * fade;
    bucket.tints[o3 + 1] = corpse.tint[1] * fade;
    bucket.tints[o3 + 2] = corpse.tint[2] * fade;

    bucket.groundHeights[idx] = terrainHeightAt(
      world.layers,
      corpse.x,
      corpse.y,
    );
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
        sunDir: sun.position,
        minuteOfDay: currentMinute,
        renderTimeSeconds: now * 0.001,
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
      resourceModelsLayer.write(nodeRows, posRows, world.layers, {
        fog: {
          isVisible: (x, y) => fog.isVisible(x, y, VIEWER),
          isExplored: (x, y) => fog.isExplored(x, y, VIEWER),
        },
      });
    }
  }

  if (shipModelsLayer) {
    shipModelsLayer.flush(spriteTimeSec, world.layers);
  }

  // Update farm furrows on terrain
  const buildingRows = world.rowsByComponentId.get(comps.buildingId);
  const posRows = world.rowsByComponentId.get(comps.positionId);
  const farmTiles: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
  }> = [];
  if (buildingRows && posRows) {
    for (const [eid, bRow] of buildingRows) {
      if (bRow[1] === 5) {
        const p = posRows.get(eid);
        if (p)
          farmTiles.push({
            x: Math.floor(p[0]!),
            y: Math.floor(p[1]!),
            width: 3,
            height: 3,
          });
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
    selectionRings.write(ringScratch, ringScratchCount, now / 1000);
  } else {
    selectionRings.write(ringScratch, 0, now / 1000);
  }

  // Rally flags for production buildings (V11 & Q1 #119)
  const selectedEids = getSelectedEids();
  const selectedBuildingEids = selectedEids.filter(
    (eid) => getBuildingRow(world, comps, eid) !== undefined,
  );
  rallyFlagLayer.update(selectedBuildingEids, now / 1000);

  // Waypoint routes for selected units (W1 #132)
  const selectedUnitEids = selectedEids.filter(
    (eid) => getBuildingRow(world, comps, eid) === undefined,
  );
  waypointLayer.update(selectedUnitEids, (eid) => {
    const pos = getPosition(world, comps, eid);
    if (!pos) return [];
    const q = readActivityQueue(world, comps, eid);
    return extractWaypointChain(pos.x, pos.y, q);
  });

  // Chimney smoke particles (V11)
  chimneySmokeLayer.setTime(now / 1000);
  chimneySinceUpdateMs += frameMs;
  if (chimneySinceUpdateMs >= 1000) {
    chimneySinceUpdateMs = 0;
    chimneySmokeLayer.updateChimneys(collectChimneyCoords(), world.layers);
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

  // Conversion visual feedback (V14 Issue #101)
  const conversions = staging?.conversions;
  if (conversions && conversions.length > 0) {
    const cCount = Math.min(conversions.length, CAST_BAR_CAPACITY);
    for (let i = 0; i < cCount; i++) {
      const conv = conversions[i]!;
      castBarOrigins[i * 3] = conv.monkX;
      castBarOrigins[i * 3 + 1] =
        terrainHeightAt(world.layers, conv.monkX, conv.monkY) + CAST_BAR_LIFT;
      castBarOrigins[i * 3 + 2] = conv.monkY;
      castBarProgress[i] = conv.progress;

      conversionRingPositions[i * 2] = conv.targetX;
      conversionRingPositions[i * 2 + 1] = conv.targetY;
    }
    castBars.write(castBarOrigins, castBarProgress, cCount);
    conversionRings.write(conversionRingPositions, cCount, now / 1000);
  } else {
    castBars.write(castBarOrigins, castBarProgress, 0);
    conversionRings.write(conversionRingPositions, 0, now / 1000);
  }

  moveMarkers.update(frameMs / 1000);

  cameraRig.update(frameMs / 1000);

  minimapSinceRedrawMs += frameMs;
  if (minimapSinceRedrawMs >= MINIMAP_REDRAW_MS) {
    minimapSinceRedrawMs = 0;
    minimap.redraw();
  } else {
    minimap.updateViewport();
  }
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
  const playerAge = currentAgeRankOf(world, comps, PLAYER_ONE);
  if (playerAge > lastPlayerAgeRank) {
    lastPlayerAgeRank = playerAge;
    ageUpBanner.show(playerAge);
    toastManager.notifyAgeUp(formatAgeToast(playerAge));
  }
  topbar.updateAge(playerAge);
  // M4-T6: disclose the AI difficulty knobs — decision interval,
  // reaction latency and hard's documented income multiplier.
  topbar.updateDifficulty(session.aiDifficulty);
  // #106: update idle worker badge every frame (cheap: just iterates
  // entity list, no allocations when count is unchanged).
  const idleVillagerEids = findIdleVillagers(world, comps, PLAYER_ONE);
  const idleCount = idleVillagerEids.length;
  topbar.updateIdleWorkers(idleCount);

  // Q2 (#121): detect new idle workers, sound alert cue and trigger toast & minimap ping
  if (idleCount > lastIdleVillagerCount && idleCount > 0) {
    const now = performance.now();
    if (now - lastIdleVillagerAlertTime >= IDLE_VILLAGER_ALERT_COOLDOWN_MS) {
      lastIdleVillagerAlertTime = now;
      audioScheduler.push({ clip: "ui.idle", priority: 6 });
      const firstEid = idleVillagerEids[0]!;
      const pos = getPosition(world, comps, firstEid);
      if (pos) {
        toastManager.notifyIdleVillager(pos.x, pos.y, idleCount);
        minimap.ping(pos.x, pos.y, "#f59e0b", 3000);
      }
    }
  }
  lastIdleVillagerCount = idleCount;
  victoryPathsPanel.update(victoryPathReadouts(world, comps, VIEWER));
  controlGroups.refreshChips();
  buildMenu.refresh();
  buildingPanel.refresh();

  // Unit selection HUD panel (V13, #90)
  const selEids = getSelectedEids();
  const selectedUnits: SelectedUnitSummary[] = [];
  for (const eid of selEids) {
    if (
      getBuildingRow(world, comps, eid) ||
      getBuildingSiteRow(world, comps, eid)
    )
      continue;
    const combatRow = world.rowsByComponentId.get(comps.combatId)?.get(eid);
    if (!combatRow) continue;
    const defCode = combatRow[0]!;
    const ownerId = combatRow[1]!;
    const hp = combatRow[2]!;
    const unitId = unitIdOfCode(defCode);
    const def = unitDefOf(unitId);
    const civBonuses = world.civilizations
      ? getCivBonuses(world, ownerId)
      : undefined;
    const stats = deriveUnitStats(def, { civBonuses });
    const identityRow = world.rowsByComponentId.get(comps.identityId)?.get(eid);
    const popName = identityRow
      ? givenNameOf(world, identityRow[0]!)
      : undefined;
    let armor = 0;
    for (const tag of def.armorClasses) {
      const a = stats.armorByClass[tag as keyof typeof stats.armorByClass];
      if (typeof a === "number" && a > armor) armor = a;
    }
    let faith: number | undefined;
    let castProgress: number | undefined;
    if (comps.faithId !== undefined) {
      const faithRow = world.rowsByComponentId.get(comps.faithId)?.get(eid);
      if (faithRow) {
        faith = faithRow[0];
        castProgress = faithRow[2];
      }
    }
    selectedUnits.push({
      eid,
      unitId,
      name: def.name,
      popName,
      hp,
      maxHp: def.hp,
      attack: stats.attack,
      armor,
      range: stats.range > 1.5 ? stats.range : undefined,
      speed: stats.speed,
      ownerId,
      isMilitary: unitId !== "villager" && unitId !== "trade-cart",
      morphTargetId: def.morphTargetId,
      siegeState: def.siegeState,
      faith,
      maxFaith: def.maxFaith,
      castProgress,
      castTicks: def.castTicks,
    });
  }
  unitPanel.update(selectedUnits);

  // Command button grid HUD (V13, #91)
  let hasGarrisonBuilding = false;
  const bRows = world.rowsByComponentId.get(comps.buildingId);
  if (bRows) {
    for (const [, row] of bRows) {
      if (row[0] === VIEWER) {
        const def = buildingDefOf(buildingIdOfCode(row[1]!));
        if (
          def.id === "town-center" ||
          def.id === "watch-tower" ||
          def.id === "castle"
        ) {
          hasGarrisonBuilding = true;
          break;
        }
      }
    }
  }
  commandPanel.update(
    selectedUnits.length > 0,
    currentStance,
    hasGarrisonBuilding,
  );

  popCard.refresh();
  domainPanel.refresh();
  companyPanel.refresh();
  companyNewsToasts();
  pollMatchOutcome();
  if (currentGraphicsQuality === "high" && postProcessing) {
    postProcessing.render(renderer, scene, cameraRig.camera);
  } else {
    renderer.render(scene, cameraRig.camera);
  }

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
  createShipModelsLayer(scene),
])
  .then(([unitLayers, bLayer, rLayer, resLayer, sLayer]) => {
    for (const layer of unitLayers) {
      if (layer) scene.add(layer.mesh);
    }
    buildingModelsLayer = bLayer;
    scene.add(buildingModelsLayer.group);
    relicModelsLayer = rLayer;
    scene.add(relicModelsLayer.group);
    resourceModelsLayer = resLayer;
    scene.add(resourceModelsLayer.group);
    shipModelsLayer = sLayer;
    requestAnimationFrame((now) => frame(now, unitLayers));
  })
  .catch((error: unknown) => {
    console.error(
      "unit atlases, buildings, relics or resources failed to load",
      error,
    );
    document.body.textContent =
      "Failed to load unit atlases or models — check assets.";
  });

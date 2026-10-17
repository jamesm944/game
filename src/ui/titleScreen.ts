/**
 * AAA Frontend Shell, Title Screen & Skirmish Match Setup Interface — Milestone F1 (Issue #139).
 *
 * Implements a medieval AAA title screen and full interactive skirmish setup:
 * 1. Title Screen Shell:
 *    - Regal branding ("Age of Wind: The Age of Kings")
 *    - Ambient backdrop with glowing particles and glassmorphic parchment panels
 *    - Navigation options: Single Player Skirmish, Continue / Load Game, Settings, Credits
 *    - Ambient audio toggle / music cue sound generator
 * 2. Skirmish Match Setup:
 *    - Interactive Civilization Picker: Britons, Franks, Goths, Byzantines
 *      Displaying high-fidelity civ crest cards with unique units, unique techs,
 *      and cultural bonuses.
 *    - AI Opponent Configuration: 1 to 3 opponents, civilization selection, and difficulty.
 *    - Map & Game Settings: Map size (72x72, 96x96, 120x120, 160x160), biome presets,
 *      starting age, and victory condition.
 *    - "Launch Match" CTA with transition fade.
 * 3. Credits Modal:
 *    - Homage to classic RTS, tech stack, and engine architecture.
 */

import { ensureAudio } from "../audio/context";

export type CivId = "britons" | "franks" | "goths" | "byzantines";
export type AiDifficultyId = "easy" | "normal" | "hard" | "expert";
export type MapSizeValue = 72 | 96 | 120 | 160;
export type BiomeValue = "continental" | "coastal" | "archipelago";
export type StartingAgeValue = 1 | 2 | 3 | 4;
export type VictoryConditionValue =
  "standard" | "conquest" | "relic" | "wonder";

export interface CivCardData {
  readonly id: CivId;
  readonly name: string;
  readonly archetype: string;
  readonly emblem: string;
  readonly crestColor: string;
  readonly bannerColor: string;
  readonly uniqueUnit: {
    readonly id: string;
    readonly name: string;
    readonly role: string;
    readonly description: string;
  };
  readonly uniqueTech: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
  };
  readonly bonuses: readonly string[];
}

export const CIV_CARDS: readonly CivCardData[] = [
  {
    id: "britons",
    name: "Britons",
    archetype: "Foot Archer & Food Civilization",
    emblem: "🏹",
    crestColor: "#c0392b",
    bannerColor:
      "linear-gradient(135deg, rgba(192, 57, 43, 0.4), rgba(142, 68, 173, 0.2))",
    uniqueUnit: {
      id: "longbowman",
      name: "Longbowman",
      role: "Elite Archer",
      description:
        "Deadly foot archer with unsurpassed range and armor piercing.",
    },
    uniqueTech: {
      id: "yeomen",
      name: "Yeomen",
      description: "+1 foot archer range, +2 watch tower attack.",
    },
    bonuses: [
      "Foot archers +1 range in Castle & Imperial Ages",
      "Food gatherers work 20% faster on all sources",
      "Town Centers cost -50% wood (138 wood)",
    ],
  },
  {
    id: "franks",
    name: "Franks",
    archetype: "Cavalry & Fortress Civilization",
    emblem: "⚜️",
    crestColor: "#2980b9",
    bannerColor:
      "linear-gradient(135deg, rgba(41, 128, 185, 0.4), rgba(44, 62, 80, 0.2))",
    uniqueUnit: {
      id: "throwing-axeman",
      name: "Throwing Axeman",
      role: "Ranged Infantry",
      description:
        "Infantry warrior hurling heavy axes with building bonus damage.",
    },
    uniqueTech: {
      id: "chivalry",
      name: "Chivalry",
      description: "Stables work 40% faster for rapid knight mobilization.",
    },
    bonuses: [
      "Cavalry units boast +20% maximum HP",
      "Castles cost -25% stone (488 stone)",
      "Foragers & berry gatherers work 15% faster",
    ],
  },
  {
    id: "goths",
    name: "Goths",
    archetype: "Infantry Swarm Civilization",
    emblem: "🦅",
    crestColor: "#7f8c8d",
    bannerColor:
      "linear-gradient(135deg, rgba(127, 140, 141, 0.4), rgba(30, 39, 46, 0.3))",
    uniqueUnit: {
      id: "huskarl",
      name: "Huskarl",
      role: "Anti-Archer Infantry",
      description:
        "Shield-bearing shock infantry heavily fortified against arrow fire.",
    },
    uniqueTech: {
      id: "anarchy",
      name: "Anarchy",
      description: "Allows training Huskarls directly at standard Barracks.",
    },
    bonuses: [
      "Infantry units cost -25% all resources",
      "Town Centers provide +10 maximum population capacity",
      "Infantry deal +2 bonus damage in melee combat",
    ],
  },
  {
    id: "byzantines",
    name: "Byzantines",
    archetype: "Defense & Counter Civilization",
    emblem: "👑",
    crestColor: "#8e44ad",
    bannerColor:
      "linear-gradient(135deg, rgba(142, 68, 173, 0.4), rgba(211, 84, 0, 0.2))",
    uniqueUnit: {
      id: "cataphract",
      name: "Cataphract",
      role: "Heavy Shock Cavalry",
      description:
        "Armored imperial cataphract inflicting devastating trample damage (+100% vs infantry).",
    },
    uniqueTech: {
      id: "greek-fire",
      name: "Greek Fire / Logistica",
      description: "Fire Ships gain +1 range; Cataphracts deal trample attack.",
    },
    bonuses: [
      "All buildings receive +25% maximum HP",
      "Skirmishers & Fire Ships cost -25% fewer resources",
      "Imperial Age advance cost discounted by -33%",
    ],
  },
];

export interface AiOpponentSetting {
  readonly slot: number;
  civ: CivId | "random";
  difficulty: AiDifficultyId;
}

export interface SkirmishMatchConfig {
  playerCiv: CivId;
  opponentCount: 1 | 2 | 3;
  opponents: AiOpponentSetting[];
  mapSize: MapSizeValue;
  biome: BiomeValue;
  startingAge: StartingAgeValue;
  victoryCondition: VictoryConditionValue;
}

export const DEFAULT_SKIRMISH_CONFIG: SkirmishMatchConfig = {
  playerCiv: "britons",
  opponentCount: 1,
  opponents: [
    { slot: 1, civ: "franks", difficulty: "normal" },
    { slot: 2, civ: "goths", difficulty: "normal" },
    { slot: 3, civ: "byzantines", difficulty: "normal" },
  ],
  mapSize: 120,
  biome: "continental",
  startingAge: 1,
  victoryCondition: "standard",
};

export const SKIRMISH_CONFIG_STORAGE_KEY = "ageofwind:skirmish_config";

export function loadSavedSkirmishConfig(
  storage: { getItem(key: string): string | null } = typeof window !==
  "undefined"
    ? window.localStorage
    : { getItem: () => null },
): SkirmishMatchConfig {
  try {
    const raw = storage.getItem(SKIRMISH_CONFIG_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SKIRMISH_CONFIG };
    const parsed = JSON.parse(raw) as Partial<SkirmishMatchConfig>;
    return {
      playerCiv: (["britons", "franks", "goths", "byzantines"].includes(
        parsed.playerCiv as string,
      )
        ? parsed.playerCiv
        : "britons") as CivId,
      opponentCount: ([1, 2, 3].includes(parsed.opponentCount as number)
        ? parsed.opponentCount
        : 1) as 1 | 2 | 3,
      opponents:
        Array.isArray(parsed.opponents) && parsed.opponents.length >= 3
          ? parsed.opponents
          : DEFAULT_SKIRMISH_CONFIG.opponents,
      mapSize: ([72, 96, 120, 160].includes(parsed.mapSize as number)
        ? parsed.mapSize
        : 120) as MapSizeValue,
      biome: (["continental", "coastal", "archipelago"].includes(
        parsed.biome as string,
      )
        ? parsed.biome
        : "continental") as BiomeValue,
      startingAge: ([1, 2, 3, 4].includes(parsed.startingAge as number)
        ? parsed.startingAge
        : 1) as StartingAgeValue,
      victoryCondition: (["standard", "conquest", "relic", "wonder"].includes(
        parsed.victoryCondition as string,
      )
        ? parsed.victoryCondition
        : "standard") as VictoryConditionValue,
    };
  } catch {
    return { ...DEFAULT_SKIRMISH_CONFIG };
  }
}

export function saveSkirmishConfig(
  config: SkirmishMatchConfig,
  storage: { setItem(key: string, value: string): void } = typeof window !==
  "undefined"
    ? window.localStorage
    : { setItem: () => {} },
): void {
  try {
    storage.setItem(SKIRMISH_CONFIG_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Ignore storage write errors (quota, sandboxing)
  }
}

import type { StrategyId } from "../sim/ai/buildOrder";

export interface SkirmishSetupOptions extends SkirmishMatchConfig {
  aiCiv?: CivId | "random";
  aiDifficulty?: AiDifficultyId;
  aiStrategy?: StrategyId;
}

export interface TitleScreenDeps {
  readonly onLaunchMatch?: (config: SkirmishMatchConfig) => void;
  readonly onStartMatch?: (options: SkirmishSetupOptions) => void;
  readonly onContinueMatch?: () => void;
  readonly onOpenSaves?: () => void;
  readonly onOpenSettings?: () => void;
  readonly onLoadSlot?: (slotName: string) => Promise<void>;
  readonly listSlots?: () => Promise<
    readonly { name: string; savedAt: number; playtimeSeconds: number }[]
  >;
  readonly onAudioToggle?: () => boolean;
  readonly isAudioMuted?: () => boolean;
  readonly onPreviewSound?: (clip: string) => void;
  readonly hasActiveMatch?: () => boolean;
  readonly initialConfig?: SkirmishMatchConfig;
}

export interface TitleScreenHandle {
  readonly root: HTMLDivElement;
  show(): void;
  showTitle(): void;
  showSetup(): void;
  showCredits(): void;
  openView(view: "main" | "setup" | "credits"): void;
  hide(): void;
  readonly isVisible: boolean;
  isOpen(): boolean;
  setHasActiveMatch(hasActive: boolean): void;
  getConfig(): SkirmishMatchConfig;
}

/** Synthesize a medieval lute / fanfare chord via Web Audio API. */
export function playTitleAudioCue(kind: "click" | "fanfare" | "select"): void {
  try {
    const ctx = ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    if (kind === "click") {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(660, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.06);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.08);
    } else if (kind === "select") {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.setValueAtTime(554.37, now + 0.05); // C#
      osc.frequency.setValueAtTime(659.25, now + 0.1); // E
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.22);
    } else if (kind === "fanfare") {
      const notes = [329.63, 440, 554.37, 659.25]; // E major chord
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(freq, now + idx * 0.06);
        gain.gain.setValueAtTime(0.08, now + idx * 0.06);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.06);
        osc.stop(now + 0.7);
      });
    }
  } catch {
    // Non-fatal if audio context is blocked
  }
}

export function createTitleScreen(deps: TitleScreenDeps): TitleScreenHandle {
  const root = document.createElement("div");
  root.id = "title-screen-shell";
  root.className = "title-screen-shell";

  let currentConfig: SkirmishMatchConfig = deps.initialConfig
    ? { ...deps.initialConfig }
    : loadSavedSkirmishConfig();

  let ambientAudioPlaying = false;
  let ambientOscNode: OscillatorNode | null = null;
  let ambientGainNode: GainNode | null = null;
  let activeMatchPresent = false;

  function toggleAmbientAudio(): void {
    if (deps.onAudioToggle) {
      ambientAudioPlaying = deps.onAudioToggle();
      updateAudioToggleBtn();
      return;
    }
    try {
      const ctx = ensureAudio();
      if (!ctx) return;
      if (ambientAudioPlaying) {
        if (ambientOscNode) {
          try {
            ambientOscNode.stop();
            ambientOscNode.disconnect();
          } catch {}
          ambientOscNode = null;
        }
        if (ambientGainNode) {
          try {
            ambientGainNode.disconnect();
          } catch {}
          ambientGainNode = null;
        }
        ambientAudioPlaying = false;
      } else {
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(110, now); // low A drone
        gain.gain.setValueAtTime(0.04, now);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        ambientOscNode = osc;
        ambientGainNode = gain;
        ambientAudioPlaying = true;
        playTitleAudioCue("select");
      }
      updateAudioToggleBtn();
    } catch {}
  }

  function updateAudioToggleBtn(): void {
    const btn = root.querySelector(
      "#title-audio-toggle",
    ) as HTMLButtonElement | null;
    if (btn) {
      btn.innerHTML = ambientAudioPlaying
        ? `<span class="icon">🔊</span> Music: ON`
        : `<span class="icon">🔇</span> Music: OFF`;
      btn.classList.toggle("active", ambientAudioPlaying);
    }
  }

  root.innerHTML = `
    <!-- Ambient Backdrop Layer with Vignette and Dust -->
    <div class="title-backdrop">
      <div class="vignette-overlay"></div>
      <div class="dust-particles"></div>
    </div>

    <!-- Top Right Utility Bar: Audio Toggle -->
    <div class="title-top-bar">
      <button id="title-audio-toggle" class="title-utility-btn" title="Toggle Title Music & Ambient Audio">
        <span class="icon">🔇</span> Music: OFF
      </button>
    </div>

    <!-- MAIN MENU VIEW -->
    <div id="title-main-view" class="title-view active">
      <div class="title-header">
        <div class="title-heraldic-crest">❖ ⚔ ❖</div>
        <div class="title-chapter-tag">CHRONICLES OF ANCIENT REALMS</div>
        <h1 class="title-branding">AGE OF WIND</h1>
        <div class="title-subtitle">THE AGE OF KINGS</div>
        <div class="title-divider-line">
          <span class="divider-embellishment">❖</span>
        </div>
      </div>

      <nav class="title-nav-menu">
        <button id="menu-btn-skirmish" class="title-menu-btn title-btn-primary">
          <span class="btn-icon">⚔</span>
          <span class="btn-label">Single Player Skirmish</span>
          <span class="btn-glint"></span>
        </button>

        <button id="menu-btn-continue" class="title-menu-btn">
          <span class="btn-icon">📜</span>
          <span class="btn-label">Continue / Load Game</span>
        </button>

        <button id="menu-btn-settings" class="title-menu-btn">
          <span class="btn-icon">⚙</span>
          <span class="btn-label">Settings</span>
        </button>

        <button id="menu-btn-credits" class="title-menu-btn">
          <span class="btn-icon">🛡</span>
          <span class="btn-label">Credits</span>
        </button>
      </nav>

      <div class="title-footer">
        <div class="title-version-badge">Age of Wind v1.1.0 • Deterministic WebGL RTS Engine</div>
        <div class="title-homage">Honoring Age of Empires II: Definitive Edition standards</div>
      </div>
    </div>

    <!-- SKIRMISH MATCH SETUP VIEW -->
    <div id="title-setup-view" class="title-view" hidden>
      <div class="setup-header">
        <h2 class="setup-title">SKIRMISH MATCH SETUP</h2>
        <p class="setup-desc">Customize civilizations, AI opponents, and battlefield terrain</p>
      </div>

      <div class="setup-grid">
        <!-- LEFT COLUMN: CIVILIZATION SHOWCASE -->
        <div class="setup-col setup-civ-section">
          <h3 class="section-title">CHOOSE YOUR CIVILIZATION</h3>
          <div class="civ-cards-grid" id="civ-cards-container">
            ${CIV_CARDS.map(
              (civ) => `
              <div class="civ-card ${civ.id === currentConfig.playerCiv ? "selected" : ""}" data-civ-id="${civ.id}">
                <div class="civ-card-header" style="background: ${civ.bannerColor}; border-top-color: ${civ.crestColor}">
                  <span class="civ-emblem">${civ.emblem}</span>
                  <div class="civ-titles">
                    <span class="civ-name">${civ.name}</span>
                    <span class="civ-archetype">${civ.archetype}</span>
                  </div>
                  <span class="civ-check-badge">✓</span>
                </div>
                <div class="civ-card-body">
                  <div class="civ-feature-row">
                    <span class="feature-tag unit-tag">Unique Unit</span>
                    <span class="feature-val"><strong>${civ.uniqueUnit.name}</strong> (${civ.uniqueUnit.role})</span>
                  </div>
                  <div class="civ-feature-desc">${civ.uniqueUnit.description}</div>
                  
                  <div class="civ-feature-row">
                    <span class="feature-tag tech-tag">Unique Tech</span>
                    <span class="feature-val"><strong>${civ.uniqueTech.name}</strong></span>
                  </div>
                  <div class="civ-feature-desc">${civ.uniqueTech.description}</div>

                  <div class="civ-bonuses-list">
                    ${civ.bonuses.map((b) => `<div class="civ-bonus-item">• ${b}</div>`).join("")}
                  </div>
                </div>
              </div>
            `,
            ).join("")}
          </div>
        </div>

        <!-- RIGHT COLUMN: OPPONENTS & BATTLEFIELD SETTINGS -->
        <div class="setup-col setup-params-section">
          <!-- AI OPPONENTS CONFIG -->
          <div class="setup-card">
            <h3 class="card-title">AI OPPONENTS</h3>
            <div class="param-row">
              <label class="param-label">Number of Opponents:</label>
              <div class="pill-group" id="opponent-count-pills">
                <button type="button" class="pill-btn ${currentConfig.opponentCount === 1 ? "active" : ""}" data-count="1">1 Opponent</button>
                <button type="button" class="pill-btn ${currentConfig.opponentCount === 2 ? "active" : ""}" data-count="2">2 Opponents</button>
                <button type="button" class="pill-btn ${currentConfig.opponentCount === 3 ? "active" : ""}" data-count="3">3 Opponents</button>
              </div>
            </div>

            <div class="opponents-roster" id="opponents-roster-container">
              <!-- Rendered dynamically -->
            </div>
          </div>

          <!-- BATTLEFIELD & RULES CONFIG -->
          <div class="setup-card">
            <h3 class="card-title">MAP & GAME SETTINGS</h3>
            
            <div class="param-row">
              <label class="param-label">Map Size:</label>
              <div class="pill-group" id="map-size-pills">
                <button type="button" class="pill-btn ${currentConfig.mapSize === 72 ? "active" : ""}" data-val="72">Tiny (72²)</button>
                <button type="button" class="pill-btn ${currentConfig.mapSize === 96 ? "active" : ""}" data-val="96">Small (96²)</button>
                <button type="button" class="pill-btn ${currentConfig.mapSize === 120 ? "active" : ""}" data-val="120">Medium (120²)</button>
                <button type="button" class="pill-btn ${currentConfig.mapSize === 160 ? "active" : ""}" data-val="160">Large (160²)</button>
              </div>
            </div>

            <div class="param-row">
              <label class="param-label">Biome / Theme:</label>
              <div class="pill-group" id="biome-pills">
                <button type="button" class="pill-btn ${currentConfig.biome === "continental" ? "active" : ""}" data-val="continental">Continental</button>
                <button type="button" class="pill-btn ${currentConfig.biome === "coastal" ? "active" : ""}" data-val="coastal">Coastal</button>
                <button type="button" class="pill-btn ${currentConfig.biome === "archipelago" ? "active" : ""}" data-val="archipelago">Archipelago</button>
              </div>
            </div>

            <div class="param-row">
              <label class="param-label">Starting Age:</label>
              <div class="pill-group" id="starting-age-pills">
                <button type="button" class="pill-btn ${currentConfig.startingAge === 1 ? "active" : ""}" data-val="1">Dark Age</button>
                <button type="button" class="pill-btn ${currentConfig.startingAge === 2 ? "active" : ""}" data-val="2">Feudal Age</button>
                <button type="button" class="pill-btn ${currentConfig.startingAge === 3 ? "active" : ""}" data-val="3">Castle Age</button>
                <button type="button" class="pill-btn ${currentConfig.startingAge === 4 ? "active" : ""}" data-val="4">Imperial Age</button>
              </div>
            </div>

            <div class="param-row">
              <label class="param-label">Victory Condition:</label>
              <div class="pill-group" id="victory-pills">
                <button type="button" class="pill-btn ${currentConfig.victoryCondition === "standard" ? "active" : ""}" data-val="standard">Standard</button>
                <button type="button" class="pill-btn ${currentConfig.victoryCondition === "conquest" ? "active" : ""}" data-val="conquest">Conquest</button>
                <button type="button" class="pill-btn ${currentConfig.victoryCondition === "relic" ? "active" : ""}" data-val="relic">Relic Hold</button>
                <button type="button" class="pill-btn ${currentConfig.victoryCondition === "wonder" ? "active" : ""}" data-val="wonder">Wonder</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- FOOTER ACTIONS -->
      <div class="setup-footer">
        <button id="setup-btn-back" class="title-menu-btn setup-back-btn">
          <span>← Back to Menu</span>
        </button>
        <button id="setup-btn-launch" class="title-menu-btn title-btn-primary setup-launch-btn">
          <span class="btn-icon">⚔</span>
          <span class="btn-label">Launch Match</span>
          <span class="btn-glint"></span>
        </button>
      </div>
    </div>

    <!-- CREDITS MODAL -->
    <div id="title-credits-modal" class="title-modal-overlay" hidden>
      <div class="title-modal-card">
        <div class="modal-header">
          <h2 class="modal-title">CHRONICLES OF AGE OF WIND</h2>
          <button id="credits-close-btn" class="modal-close-btn">✕</button>
        </div>
        <div class="modal-body">
          <p class="credits-tribute">
            <strong>Age of Wind</strong> is a next-generation real-time strategy experience built from first principles
            in pure TypeScript, WebGL, and Web Audio, honoring the strategic depth, visual clarity, and timeless elegance
            of <em>Age of Empires II: Definitive Edition</em>.
          </p>
          <div class="credits-section">
            <h3>Engine Architecture</h3>
            <p>Deterministic Entity Component System • Multi-tier IAUS Utility AI • Bit-identical Replay & Golden Verification Engine</p>
          </div>
          <div class="credits-section">
            <h3>Rendering & Audio</h3>
            <p>Three.js WebGL rendering with PCF soft directional shadows, normal-mapped terrain splatting, and algorithmic audio synthesis</p>
          </div>
          <div class="credits-section">
            <h3>Civilizations</h3>
            <p>Britons (Archery & Food) • Franks (Cavalry & Castles) • Goths (Infantry Swarm) • Byzantines (Imperial Defense)</p>
          </div>
        </div>
        <div class="modal-footer">
          <button id="credits-ack-btn" class="title-menu-btn">Return to Title</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(root);

  // Views references
  const mainView = root.querySelector("#title-main-view") as HTMLDivElement;
  const setupView = root.querySelector("#title-setup-view") as HTMLDivElement;
  const creditsModal = root.querySelector(
    "#title-credits-modal",
  ) as HTMLDivElement;
  const opponentsContainer = root.querySelector(
    "#opponents-roster-container",
  ) as HTMLDivElement;

  function renderOpponentsRoster(): void {
    const count = currentConfig.opponentCount;
    let html = "";
    for (let slot = 1; slot <= count; slot++) {
      const opp = currentConfig.opponents[slot - 1] ?? {
        slot,
        civ: "random",
        difficulty: "normal",
      };
      html += `
        <div class="opponent-slot-row" data-slot="${slot}">
          <div class="slot-badge slot-badge-${slot}">Player ${slot + 1}</div>
          <div class="slot-field">
            <label>Civilization:</label>
            <select class="opponent-civ-select" data-slot="${slot}">
              <option value="random" ${opp.civ === "random" ? "selected" : ""}>Random Civ</option>
              <option value="britons" ${opp.civ === "britons" ? "selected" : ""}>Britons</option>
              <option value="franks" ${opp.civ === "franks" ? "selected" : ""}>Franks</option>
              <option value="goths" ${opp.civ === "goths" ? "selected" : ""}>Goths</option>
              <option value="byzantines" ${opp.civ === "byzantines" ? "selected" : ""}>Byzantines</option>
            </select>
          </div>
          <div class="slot-field">
            <label>Difficulty:</label>
            <select class="opponent-diff-select" data-slot="${slot}">
              <option value="easy" ${opp.difficulty === "easy" ? "selected" : ""}>Easy</option>
              <option value="normal" ${opp.difficulty === "normal" ? "selected" : ""}>Moderate</option>
              <option value="hard" ${opp.difficulty === "hard" ? "selected" : ""}>Hard</option>
              <option value="expert" ${opp.difficulty === "expert" ? "selected" : ""}>Expert</option>
            </select>
          </div>
        </div>
      `;
    }
    opponentsContainer.innerHTML = html;

    opponentsContainer
      .querySelectorAll(".opponent-civ-select")
      .forEach((el) => {
        el.addEventListener("change", (e) => {
          const slot = Number(
            (e.target as HTMLElement).getAttribute("data-slot"),
          );
          const civ = (e.target as HTMLSelectElement).value as CivId | "random";
          const targetOpp = currentConfig.opponents.find(
            (o) => o.slot === slot,
          );
          if (targetOpp) targetOpp.civ = civ;
          saveSkirmishConfig(currentConfig);
          playTitleAudioCue("click");
        });
      });

    opponentsContainer
      .querySelectorAll(".opponent-diff-select")
      .forEach((el) => {
        el.addEventListener("change", (e) => {
          const slot = Number(
            (e.target as HTMLElement).getAttribute("data-slot"),
          );
          const diff = (e.target as HTMLSelectElement).value as AiDifficultyId;
          const targetOpp = currentConfig.opponents.find(
            (o) => o.slot === slot,
          );
          if (targetOpp) targetOpp.difficulty = diff;
          saveSkirmishConfig(currentConfig);
          playTitleAudioCue("click");
        });
      });
  }

  // Wire Audio Toggle
  root.querySelector("#title-audio-toggle")?.addEventListener("click", () => {
    toggleAmbientAudio();
  });

  // Wire Civ Selection Cards
  root.querySelectorAll(".civ-card").forEach((card) => {
    card.addEventListener("click", () => {
      const civId = card.getAttribute("data-civ-id") as CivId;
      if (!civId) return;
      currentConfig.playerCiv = civId;
      root
        .querySelectorAll(".civ-card")
        .forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      saveSkirmishConfig(currentConfig);
      playTitleAudioCue("select");
    });
  });

  // Wire Pill Groups
  function wirePillGroup(
    containerId: string,
    onSelect: (val: string) => void,
  ): void {
    const container = root.querySelector(containerId);
    if (!container) return;
    container.querySelectorAll(".pill-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const val =
          btn.getAttribute("data-count") ?? btn.getAttribute("data-val");
        if (!val) return;
        container
          .querySelectorAll(".pill-btn")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        onSelect(val);
        saveSkirmishConfig(currentConfig);
        playTitleAudioCue("click");
      });
    });
  }

  wirePillGroup("#opponent-count-pills", (val) => {
    currentConfig.opponentCount = Number(val) as 1 | 2 | 3;
    renderOpponentsRoster();
  });

  wirePillGroup("#map-size-pills", (val) => {
    currentConfig.mapSize = Number(val) as MapSizeValue;
  });

  wirePillGroup("#biome-pills", (val) => {
    currentConfig.biome = val as BiomeValue;
  });

  wirePillGroup("#starting-age-pills", (val) => {
    currentConfig.startingAge = Number(val) as StartingAgeValue;
  });

  wirePillGroup("#victory-pills", (val) => {
    currentConfig.victoryCondition = val as VictoryConditionValue;
  });

  // Wire Main Navigation Buttons
  root.querySelector("#menu-btn-skirmish")?.addEventListener("click", () => {
    playTitleAudioCue("click");
    showSetup();
  });

  root.querySelector("#menu-btn-continue")?.addEventListener("click", () => {
    playTitleAudioCue("click");
    const isActive = deps.hasActiveMatch
      ? deps.hasActiveMatch()
      : activeMatchPresent;
    if (isActive) {
      deps.onContinueMatch?.();
      hide();
    } else {
      deps.onOpenSaves?.();
    }
  });

  root.querySelector("#menu-btn-settings")?.addEventListener("click", () => {
    playTitleAudioCue("click");
    deps.onOpenSettings?.();
  });

  root.querySelector("#menu-btn-credits")?.addEventListener("click", () => {
    playTitleAudioCue("click");
    showCredits();
  });

  root.querySelector("#credits-close-btn")?.addEventListener("click", () => {
    playTitleAudioCue("click");
    creditsModal.hidden = true;
  });

  root.querySelector("#credits-ack-btn")?.addEventListener("click", () => {
    playTitleAudioCue("click");
    creditsModal.hidden = true;
  });

  root.querySelector("#setup-btn-back")?.addEventListener("click", () => {
    playTitleAudioCue("click");
    showTitle();
  });

  root.querySelector("#setup-btn-launch")?.addEventListener("click", () => {
    playTitleAudioCue("fanfare");
    saveSkirmishConfig(currentConfig);
    root.classList.add("fade-out");
    setTimeout(() => {
      hide();
      root.classList.remove("fade-out");
      const launchOptions: SkirmishSetupOptions = {
        ...currentConfig,
        aiCiv: currentConfig.opponents[0]?.civ ?? "random",
        aiDifficulty: currentConfig.opponents[0]?.difficulty ?? "normal",
      };
      if (deps.onStartMatch) {
        deps.onStartMatch(launchOptions);
      } else if (deps.onLaunchMatch) {
        deps.onLaunchMatch(currentConfig);
      }
    }, 350);
  });

  function showTitle(): void {
    mainView.hidden = false;
    mainView.classList.add("active");
    setupView.hidden = true;
    setupView.classList.remove("active");
    creditsModal.hidden = true;
    root.hidden = false;
    updateContinueButtonState();
  }

  function showSetup(): void {
    mainView.hidden = true;
    mainView.classList.remove("active");
    setupView.hidden = false;
    setupView.classList.add("active");
    creditsModal.hidden = true;
    root.hidden = false;
    renderOpponentsRoster();
  }

  function showCredits(): void {
    creditsModal.hidden = false;
  }

  function hide(): void {
    root.hidden = true;
    creditsModal.hidden = true;
  }

  function updateContinueButtonState(): void {
    const continueBtn = root.querySelector(
      "#menu-btn-continue",
    ) as HTMLButtonElement | null;
    if (continueBtn) {
      const active = deps.hasActiveMatch
        ? deps.hasActiveMatch()
        : activeMatchPresent;
      const label = continueBtn.querySelector(".btn-label");
      if (label) {
        label.textContent = active ? "Continue Match" : "Continue / Load Game";
      }
      continueBtn.classList.toggle("has-active", active);
    }
  }

  // Initial opponent render
  renderOpponentsRoster();
  updateContinueButtonState();

  return {
    root,
    show(): void {
      showTitle();
    },
    showTitle,
    showSetup,
    showCredits,
    openView(view: "main" | "setup" | "credits"): void {
      if (view === "main") showTitle();
      else if (view === "setup") showSetup();
      else showCredits();
    },
    hide,
    get isVisible(): boolean {
      return !root.hidden;
    },
    isOpen(): boolean {
      return !root.hidden;
    },
    setHasActiveMatch(hasActive: boolean): void {
      activeMatchPresent = hasActive;
      updateContinueButtonState();
    },
    getConfig(): SkirmishMatchConfig {
      return { ...currentConfig };
    },
  };
}

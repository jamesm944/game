/**
 * Settings panel — M5-T4 (SPEC §2.13 chrome pass).
 *
 * Framework-free fixed panel like every ui/ module, toggled from a
 * small button beside the minimap:
 *
 * - AUDIO BUS VOLUMES: one slider per §2.10 bus (master, music, sfx,
 *   ui, ambient). Every change persists through the SAME store the
 *   audio graph reads — live buses get audio/buses.setBusVolume (gain
 *   + localStorage); before the gesture-gated context exists the pure
 *   persistVolume helper writes the identical key/format so
 *   createBuses picks the value up on first unlock.
 * - DIFFICULTY SELECTOR: easy/normal/hard feeding the session
 *   bootstrap via stashDifficulty/consumeDifficulty around
 *   localStorage (same handoff pattern as the restart seed in
 *   game/session.ts). Applies to the next match — the running world's
 *   knobs are fixed at boot.
 * - AUTOSAVE INTERVAL DISPLAY: the §2.12 cadence rendered from the
 *   AUTOSAVE_INTERVAL_TICKS constant, never a hardcoded string.
 *
 * Everything pure (volume parse/clamp/merge, difficulty round-trip,
 * interval formatting) is exported for node tests; all element
 * creation lives inside createSettingsPanel.
 */

import { AI_DIFFICULTIES, type AiDifficultyId } from "../sim/ai/difficulty";
import { STRATEGY_IDS, type StrategyId } from "../sim/ai/buildOrder";
// The volume store's key + defaults live with the mix graph they
// belong to; re-exported here so UI consumers (and headless tests,
// which may not touch audio/*) share one source without drift.
import { DEFAULT_BUS_VOLUMES, VOLUME_KEY } from "../audio/buses";

export { DEFAULT_BUS_VOLUMES, VOLUME_KEY };

// ---- Volume persistence (pure) ---------------------------------------------

/** All mix-graph gains the panel exposes, master included. */
export const BUS_VOLUME_NAMES = [
  "master",
  "music",
  "sfx",
  "ui",
  "ambient",
] as const;
export type BusVolumeName = (typeof BUS_VOLUME_NAMES)[number];

/** Minimal storage surface (localStorage in production, Map fake in tests). */
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** One-shot stashes clear themselves on consume. */
  removeItem(key: string): void;
}

/** Clamp to the [0,1] gain range; NaN degrades to 0 (silent). */
export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Parse a stored volumes JSON blob into clamped bus values overlaid on
 * the canonical defaults (audio/buses.DEFAULT_BUS_VOLUMES). Missing,
 * corrupt or non-object blobs fall back per-bus to defaults.
 */
export function parseStoredVolumes(
  raw: string | null,
): Record<BusVolumeName, number> {
  const out = { ...DEFAULT_BUS_VOLUMES };
  if (raw === null) return out;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return out;
    }
    const record = parsed as Record<string, unknown>;
    for (const name of BUS_VOLUME_NAMES) {
      const value = record[name];
      if (typeof value === "number") out[name] = clampVolume(value);
    }
    return out;
  } catch {
    return out;
  }
}

/** Read the persisted volume map from storage (defaults when absent). */
export function readStoredVolumes(
  storage: SettingsStorage,
): Record<BusVolumeName, number> {
  return parseStoredVolumes(storage.getItem(VOLUME_KEY));
}

/**
 * Merge one clamped volume into the stored blob and write it back —
 * the no-live-bus persistence path (identical key/format to
 * audio/buses.setBusVolume). Returns the merged map for callers that
 * want to repaint sliders.
 */
export function persistVolume(
  storage: SettingsStorage,
  name: BusVolumeName,
  value: number,
): Record<BusVolumeName, number> {
  const merged = parseStoredVolumes(storage.getItem(VOLUME_KEY));
  merged[name] = clampVolume(value);
  storage.setItem(VOLUME_KEY, JSON.stringify(merged));
  return merged;
}

/** `82%` style slider label. */
export function formatVolumePct(value: number): string {
  return `${String(Math.round(clampVolume(value) * 100))}%`;
}

// ---- Difficulty handoff (session bootstrap feed) ----------------------------

const DIFFICULTY_STORAGE_KEY = "ageofwind.difficulty";

/**
 * Stash the chosen difficulty for the NEXT session bootstrap (new
 * page load or victory-screen Restart). Same one-shot stash semantics
 * as game/session.stashNextSeed.
 */
export function stashDifficulty(
  storage: SettingsStorage,
  id: AiDifficultyId,
): void {
  storage.setItem(DIFFICULTY_STORAGE_KEY, id);
}

/**
 * Consume the stashed difficulty, if valid: unknown ids / corrupt
 * values yield undefined (boot falls back to normal) and the key is
 * always cleared so one stash fires exactly one boot.
 */
export function consumeDifficulty(
  storage: SettingsStorage,
): AiDifficultyId | undefined {
  const raw = storage.getItem(DIFFICULTY_STORAGE_KEY);
  storage.removeItem(DIFFICULTY_STORAGE_KEY);
  if (raw === null) return undefined;
  return raw in AI_DIFFICULTIES ? (raw as AiDifficultyId) : undefined;
}

// ---- AI strategy selection & persistence --------------------------------------

export const STRATEGY_STORAGE_KEY = "ageofwind.strategy";
export type AiStrategyOption = StrategyId | "random";

export function stashStrategy(
  storage: SettingsStorage,
  strategy: AiStrategyOption,
): void {
  storage.setItem(STRATEGY_STORAGE_KEY, strategy);
}

export function readStoredStrategy(
  storage: SettingsStorage,
): AiStrategyOption {
  const raw = storage.getItem(STRATEGY_STORAGE_KEY);
  if (raw === "random") return "random";
  return raw && (STRATEGY_IDS as readonly string[]).includes(raw)
    ? (raw as StrategyId)
    : "fast-castle-knights";
}

export function consumeStrategy(
  storage: SettingsStorage,
): AiStrategyOption | undefined {
  const raw = storage.getItem(STRATEGY_STORAGE_KEY);
  storage.removeItem(STRATEGY_STORAGE_KEY);
  if (raw === null) return undefined;
  if (raw === "random") return "random";
  return (STRATEGY_IDS as readonly string[]).includes(raw)
    ? (raw as StrategyId)
    : undefined;
}

// ---- Autosave cadence display -------------------------------------------------

/**
 * Human line for an autosave interval in ticks @30 Hz: whole
 * sim-minutes read as `every 2 sim-minutes`, shorter spans as
 * `every 45 sim-seconds`.
 */
export function formatAutosaveInterval(
  ticks: number,
  ticksPerSecond = 30,
): string {
  const seconds = Math.round(ticks / ticksPerSecond);
  if (seconds % 60 === 0 && seconds > 0) {
    const minutes = seconds / 60;
    return `every ${String(minutes)} sim-minute${minutes === 1 ? "" : "s"}`;
  }
  return `every ${String(seconds)} sim-seconds`;
}

// ---- Panel chrome (browser-only) ----------------------------------------------

export interface SettingsPanelDeps {
  /** Persisted bus volumes for initial slider positions. */
  readonly volumes: Record<BusVolumeName, number>;
  /** Apply + persist one volume change (live bus or storage-only). */
  onSetVolume(name: BusVolumeName, value: number): void;
  /** The RUNNING match's difficulty (knobs are fixed at boot). */
  readonly difficulty: AiDifficultyId;
  /** Stash a difficulty for the next session bootstrap. */
  onSetDifficulty(id: AiDifficultyId): void;
  /** The current or stashed AI opening strategy. */
  readonly strategy?: AiStrategyOption | undefined;
  /** Stash an opening strategy for the next match. */
  onSetStrategy?(strategy: AiStrategyOption): void;
  /** Optional audio preview trigger on volume adjustments. */
  onPreviewSound?(clip: "ui.click" | "act.chop" | "ui.order"): void;
  /** Preformatted autosave cadence line. */
  readonly autosaveLabel: string;
}

export interface SettingsHandle {
  readonly root: HTMLDivElement;
}

function capitalize(slug: string): string {
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

export function createSettingsPanel(deps: SettingsPanelDeps): SettingsHandle {
  const toggle = document.createElement("button");
  toggle.id = "settings-toggle";
  toggle.textContent = "Settings";
  document.body.appendChild(toggle);

  const panel = document.createElement("div");
  panel.id = "settings-panel";
  panel.hidden = true;

  const title = document.createElement("h3");
  title.textContent = "Settings";
  panel.appendChild(title);

  // Audio buses block: one range input per bus, persisted per move.
  const audioHeading = document.createElement("h4");
  audioHeading.textContent = "Audio";
  panel.appendChild(audioHeading);
  const sliderRows = new Map<BusVolumeName, HTMLSpanElement>();
  for (const name of BUS_VOLUME_NAMES) {
    const row = document.createElement("label");
    row.className = "settings-volume-row";
    const label = document.createElement("span");
    label.className = "settings-volume-label";
    label.textContent = capitalize(name);
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "1";
    slider.step = "0.05";
    slider.value = String(deps.volumes[name]);
    slider.dataset.bus = name;
    const valueEl = document.createElement("span");
    valueEl.className = "settings-volume-value";
    valueEl.textContent = formatVolumePct(deps.volumes[name]);
    slider.addEventListener("input", () => {
      const value = Number(slider.value);
      valueEl.textContent = formatVolumePct(value);
      deps.onSetVolume(name, value);
      if (name === "ui") deps.onPreviewSound?.("ui.click");
      else if (name === "sfx") deps.onPreviewSound?.("act.chop");
      else if (name === "master") deps.onPreviewSound?.("ui.order");
    });
    sliderRows.set(name, valueEl);
    row.append(label, slider, valueEl);
    panel.appendChild(row);
  }

  // Difficulty selector: applies to the next session bootstrap.
  const difficultyHeading = document.createElement("h4");
  difficultyHeading.textContent = "AI difficulty";
  const difficultyRow = document.createElement("label");
  difficultyRow.className = "settings-difficulty-row";
  const select = document.createElement("select");
  select.id = "settings-difficulty";
  for (const id of Object.keys(AI_DIFFICULTIES) as AiDifficultyId[]) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = capitalize(id);
    select.appendChild(option);
  }
  select.value = deps.difficulty;
  select.addEventListener("change", () => {
    deps.onSetDifficulty(select.value as AiDifficultyId);
  });
  const difficultyNote = document.createElement("span");
  difficultyNote.className = "settings-note";
  difficultyNote.textContent = "applies to the next match";
  difficultyRow.append(select, difficultyNote);
  panel.append(difficultyHeading, difficultyRow);

  // Strategy selector: applies to the next session bootstrap.
  const strategyHeading = document.createElement("h4");
  strategyHeading.textContent = "AI opening strategy";
  const strategyRow = document.createElement("label");
  strategyRow.className = "settings-difficulty-row";
  const strategySelect = document.createElement("select");
  strategySelect.id = "settings-strategy";

  const strategyOptions: Array<{ id: AiStrategyOption; label: string }> = [
    { id: "fast-castle-knights", label: "Fast Castle → Knights (Default)" },
    { id: "scouts-rush", label: "Scouts Rush (Aggressive)" },
    { id: "archers-push", label: "Archers Push (Ranged Mass)" },
    { id: "random", label: "Random (Seed-based)" },
  ];

  for (const opt of strategyOptions) {
    const option = document.createElement("option");
    option.value = opt.id;
    option.textContent = opt.label;
    strategySelect.appendChild(option);
  }
  strategySelect.value = deps.strategy ?? "fast-castle-knights";
  strategySelect.addEventListener("change", () => {
    deps.onSetStrategy?.(strategySelect.value as AiStrategyOption);
  });
  const strategyNote = document.createElement("span");
  strategyNote.className = "settings-note";
  strategyNote.textContent = "applies to the next match";
  strategyRow.append(strategySelect, strategyNote);
  panel.append(strategyHeading, strategyRow);

  // Autosave cadence display (read-only).
  const autosaveRow = document.createElement("div");
  autosaveRow.className = "settings-autosave-row";
  autosaveRow.textContent = `Autosave ${deps.autosaveLabel}`;
  panel.appendChild(autosaveRow);

  document.body.appendChild(panel);

  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
  });

  return { root: panel };
}

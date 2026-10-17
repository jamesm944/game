/**
 * Pause menu with the save/load + replay section — SPEC §2.12 + §2.13
 * game chrome (M5-T2 issue #64, M5-T3 issue #65).
 *
 * Full-screen overlay (framework-free vanilla DOM like every ui/ panel):
 * Resume plus a SAVES block listing every IndexedDB slot — three rolling
 * autosaves and named manual slots — each row offering Load, Export,
 * Delete; header actions offer "Save as…" (named manual slot), an
 * Import `.ageof` file picker, "Export replay" (`<map>-<tick>.ageofreplay`
 * download) and an Import-replay picker that headlessly replays the
 * attached artifact. All persistence flows through injected async
 * callbacks (game/saveManager.ts owns storage, game/replayPlayer.ts owns
 * playback); this module is pure chrome and never touches IndexedDB or
 * the sim itself.
 *
 * While open the caller pauses stepping (the `paused` getter); Esc
 * toggles via `toggle()`. Slot rows repaint on every `refresh()`.
 */

export interface SaveSlotRow {
  readonly name: string;
  readonly savedAt: number;
  readonly playtimeSeconds: number;
}

export interface PauseMenuCallbacks {
  /** Leave the menu unpaused again. */
  onResume(): void;
  /** Write a new named manual slot from the current world. */
  onSave(name: string): Promise<void>;
  /** Rebuild the session from a slot's container bytes. */
  onLoad(name: string): Promise<void>;
  /** Download `<name>.ageof` for one slot. */
  onExport(name: string): Promise<void>;
  /** Delete one slot (autosaves included). */
  onDelete(name: string): Promise<void>;
  /** Validate + store an imported `.ageof` file as a manual slot. */
  onImport(file: File): Promise<void>;
  /** Download this match's recorded replay as `.ageofreplay`. */
  onExportReplay(): Promise<void>;
  /** Parse + headlessly replay an imported `.ageofreplay` file. */
  onImportReplay(file: File): Promise<void>;
  /** Fresh slot list for the rows table (called before each paint). */
  listSlots(): Promise<readonly SaveSlotRow[]>;
  /** Return to title screen / main menu (Milestone F1 / Issue #139). */
  onExitToMainMenu?(): void;
}

export interface PauseMenuHandle {
  readonly root: HTMLDivElement;
  show(): void;
  hide(): void;
  toggle(): void;
  get isOpen(): boolean;
  /** Repaint the slot rows from the injected listSlots callback. */
  refresh(): Promise<void>;
  /** Surface a save-pipeline message inline (busy/format errors). */
  note(message: string): void;
}

function formatPlaytime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(minutes)}:${String(rest).padStart(2, "0")}`;
}

function formatSavedAt(savedAt: number): string {
  if (!Number.isFinite(savedAt) || savedAt <= 0) return "—";
  return new Date(savedAt).toLocaleString();
}

/** Manual-slot name sanitizer: trims, collapses, caps length. */
export function sanitizeSlotName(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, " ").slice(0, 40);
  return cleaned;
}

export function createPauseMenu(
  callbacks: PauseMenuCallbacks,
): PauseMenuHandle {
  const root = document.createElement("div");
  root.id = "pause-menu";
  root.hidden = true;
  root.innerHTML = `
    <div id="pause-panel">
      <h2 id="pause-title">Paused</h2>
      <div class="pause-actions">
        <button id="pause-resume">Resume</button>
        <button id="pause-save">Save as…</button>
        <button id="pause-import">Import .ageof…</button>
        <input id="pause-import-file" type="file" accept=".ageof" hidden />
      </div>
      <div class="pause-actions">
        <button id="pause-export-replay">Export replay</button>
        <button id="pause-import-replay">Import replay…</button>
        <input id="pause-import-replay-file" type="file" accept=".ageofreplay,application/json" hidden />
      </div>
      <div class="pause-actions pause-nav-actions">
        <button id="pause-main-menu">Return to Main Menu</button>
      </div>
      <p id="save-note" hidden></p>
      <h3>Saves</h3>
      <div id="save-slots"></div>
    </div>
  `;
  document.body.appendChild(root);

  const slotsEl = root.querySelector("#save-slots") as HTMLDivElement;
  const noteEl = root.querySelector("#save-note") as HTMLParagraphElement;
  const importInput = root.querySelector(
    "#pause-import-file",
  ) as HTMLInputElement;
  const replayImportInput = root.querySelector(
    "#pause-import-replay-file",
  ) as HTMLInputElement;

  function note(message: string): void {
    noteEl.textContent = message;
    noteEl.hidden = false;
  }

  function clearNote(): void {
    noteEl.hidden = true;
    noteEl.textContent = "";
  }

  async function guarded(action: () => Promise<void>): Promise<void> {
    clearNote();
    try {
      await action();
    } catch (error) {
      note(error instanceof Error ? error.message : String(error));
    }
    await refresh().catch(() => {});
  }

  async function refresh(): Promise<void> {
    const slots = await callbacks.listSlots();
    slotsEl.textContent = "";
    if (slots.length === 0) {
      const empty = document.createElement("p");
      empty.className = "save-empty";
      empty.textContent = "No saves yet — autosave runs every 2 sim-minutes.";
      slotsEl.appendChild(empty);
      return;
    }
    for (const slot of slots) {
      const row = document.createElement("div");
      row.className = "save-row";
      row.dataset.slot = slot.name;

      const label = document.createElement("span");
      label.className = "save-label";
      label.textContent = `${slot.name} · tick clock ${formatPlaytime(slot.playtimeSeconds)} · ${formatSavedAt(slot.savedAt)}`;
      row.appendChild(label);

      const actions = document.createElement("span");
      actions.className = "save-actions";
      const load = document.createElement("button");
      load.textContent = "Load";
      load.addEventListener(
        "click",
        () => void guarded(() => callbacks.onLoad(slot.name)),
      );
      const exportBtn = document.createElement("button");
      exportBtn.textContent = "Export";
      exportBtn.addEventListener(
        "click",
        () => void guarded(() => callbacks.onExport(slot.name)),
      );
      const del = document.createElement("button");
      del.textContent = "Delete";
      del.addEventListener(
        "click",
        () => void guarded(() => callbacks.onDelete(slot.name)),
      );
      actions.append(load, exportBtn, del);
      row.appendChild(actions);
      slotsEl.appendChild(row);
    }
  }

  function show(): void {
    clearNote();
    root.hidden = false;
    void refresh().catch((error) => note(String(error)));
  }

  function hide(): void {
    root.hidden = true;
  }

  root.querySelector("#pause-resume")!.addEventListener("click", hide);

  root.querySelector("#pause-save")!.addEventListener("click", () => {
    const raw = window.prompt(
      "Save slot name:",
      `match ${new Date().toLocaleDateString()}`,
    );
    if (raw === null) return;
    const name = sanitizeSlotName(raw);
    if (name.length === 0) {
      note("Slot name cannot be empty.");
      return;
    }
    void guarded(() => callbacks.onSave(name));
  });

  root.querySelector("#pause-import")!.addEventListener("click", () => {
    importInput.click();
  });
  importInput.addEventListener("change", () => {
    const file = importInput.files?.[0];
    importInput.value = "";
    if (file !== undefined) void guarded(() => callbacks.onImport(file));
  });

  root.querySelector("#pause-export-replay")!.addEventListener("click", () => {
    void guarded(() => callbacks.onExportReplay());
  });
  root.querySelector("#pause-import-replay")!.addEventListener("click", () => {
    replayImportInput.click();
  });
  replayImportInput.addEventListener("change", () => {
    const file = replayImportInput.files?.[0];
    replayImportInput.value = "";
    if (file !== undefined) void guarded(() => callbacks.onImportReplay(file));
  });

  const mainMenuBtn = root.querySelector("#pause-main-menu");
  if (mainMenuBtn) {
    mainMenuBtn.addEventListener("click", () => {
      hide();
      callbacks.onExitToMainMenu?.();
    });
  }

  return {
    root,
    show,
    hide,
    toggle: () => (root.hidden ? show() : hide()),
    get isOpen(): boolean {
      return !root.hidden;
    },
    refresh,
    note,
  };
}

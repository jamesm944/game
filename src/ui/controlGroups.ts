/**
 * Control groups — SPEC §2.13 prototype-validated command layer.
 *
 * Ctrl/⌘+1..4 store the current selection as group N; 1..4 recall it as
 * the selection (reselect only — nothing is re-issued); a second tap of
 * the same digit within ~350 ms centers the camera on the group's live
 * centroid via `setCenter`. Dead members are pruned silently and chips
 * always show LIVE member counts (CONTROLS.md).
 *
 * The module imports nothing browser-specific at top level: DOM chips
 * are created inside `wireControlGroups`, so node test suites can load
 * this file safely if needed.
 */

import type { SelectionFrame } from "./selection";

/** Double-tap window for camera centering, milliseconds. */
const DOUBLE_TAP_MS = 350;
/** Group slots 1..4 → indices 0..3. */
const GROUP_SLOTS = 4;

const DIGIT_CODES = ["Digit1", "Digit2", "Digit3", "Digit4"] as const;

export interface ControlGroupDeps {
  /** Latest post-step snapshot for liveness + centroid positions. */
  getFrame(): SelectionFrame | null;
  /** Current selection ids (store copies them). */
  selection(): readonly number[];
  /** Replace the selection wholesale (recall reselects, never re-issues). */
  setSelection(eids: readonly number[]): void;
  /** Camera jump hook (minimap-style centering). */
  setCenter(x: number, y: number): void;
}

export interface ControlGroupsHandle {
  /** Refresh chip counts against current liveness; call once per frame. */
  refreshChips(): void;
  dispose(): void;
}

/** Live member ids of one stored group (prunes dead silently). */
function liveMembers(
  stored: readonly number[],
  frame: SelectionFrame | null,
): number[] {
  if (stored.length === 0 || !frame || frame.count === 0) return [];
  const members: number[] = [];
  for (const eid of stored) {
    if (frame.eids.includes(eid)) members.push(eid);
  }
  return members;
}

export function wireControlGroups(deps: ControlGroupDeps): ControlGroupsHandle {
  const groups: number[][] = Array.from(
    { length: GROUP_SLOTS },
    () => [] as number[],
  );
  let lastTapSlot = -1;
  let lastTapTime = -Infinity;

  // ---- Chips UI --------------------------------------------------------------
  const bar = document.createElement("div");
  bar.id = "group-bar";
  const chipTexts: string[] = [];
  const chips: HTMLDivElement[] = [];
  document.body.appendChild(bar);
  for (let slot = 0; slot < GROUP_SLOTS; slot++) {
    const chip = document.createElement("div");
    chip.className = "group-chip";
    chip.innerHTML = `<b>${String(slot + 1)}</b><span>–</span>`;
    chip.addEventListener("click", () => recall(slot));
    bar.appendChild(chip);
    chips.push(chip);
    chipTexts.push("");
  }

  function flashChip(slot: number): void {
    const chip = chips[slot];
    if (!chip) return;
    chip.classList.remove("flash");
    // Restart the CSS animation on back-to-back flashes.
    void chip.offsetWidth;
    chip.classList.add("flash");
  }

  function updateChipLabel(slot: number): void {
    const chip = chips[slot];
    if (!chip) return;
    const count = liveMembers(groups[slot]!, deps.getFrame()).length;
    const text = count > 0 ? String(count) : "–";
    if (text !== chipTexts[slot]) {
      chipTexts[slot] = text;
      const label = chip.querySelector("span");
      if (label) label.textContent = text;
    }
  }

  // ---- Store / recall ----------------------------------------------------------

  function store(slot: number): void {
    groups[slot] = [...deps.selection()];
    flashChip(slot);
  }

  function recall(slot: number): void {
    const members = liveMembers(groups[slot]!, deps.getFrame());
    groups[slot] = members; // prune dead silently
    if (members.length === 0) return;
    deps.setSelection(members);
    flashChip(slot);

    // Double-tap centers the camera on the group's live centroid.
    const now = performance.now();
    if (lastTapSlot === slot && now - lastTapTime <= DOUBLE_TAP_MS) {
      const frame = deps.getFrame();
      if (frame && frame.count > 0) {
        let cx = 0;
        let cy = 0;
        let found = 0;
        for (const eid of members) {
          const rank = frame.eids.indexOf(eid);
          if (rank < 0) continue;
          cx += frame.positions[rank * 2]!;
          cy += frame.positions[rank * 2 + 1]!;
          found += 1;
        }
        if (found > 0) deps.setCenter(cx / found, cy / found);
      }
      lastTapSlot = -1;
      lastTapTime = -Infinity;
      return;
    }
    lastTapSlot = slot;
    lastTapTime = now;
  }

  window.addEventListener("keydown", (event: KeyboardEvent) => {
    const slot = DIGIT_CODES.indexOf(
      event.code as (typeof DIGIT_CODES)[number],
    );
    if (slot < 0) return;
    event.preventDefault(); // stop browser tab-switching on Ctrl/Cmd+1..4
    if (event.ctrlKey || event.metaKey) {
      if (!event.repeat) store(slot);
      return;
    }
    if (event.repeat) return;
    recall(slot);
  });

  return {
    refreshChips(): void {
      for (let slot = 0; slot < GROUP_SLOTS; slot++) updateChipLabel(slot);
    },
    dispose(): void {
      bar.remove();
    },
  };
}

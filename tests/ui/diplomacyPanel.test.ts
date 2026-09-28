/**
 * Multi-Player HUD, Diplomacy Panel & Leaderboard Unit Tests — Milestone S3 (#116).
 *
 * Verifies:
 * 1. Interactive Diplomacy & Tribute Panel (open/close, stance toggling, tribute transfer validation).
 * 2. Multi-Player RTS Civilization Score Calculation & Leaderboard HUD (sorting, age numerals, status).
 * 3. Minimap multi-player color rendering for 4 players (Blue, Red, Green, Yellow).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  createDiplomacyPanel,
  type PlayerDiplomacyInfo,
  type DiplomacyPanelCallbacks,
} from "../../src/ui/diplomacyPanel";
import {
  calculatePlayerScore,
  createScoreLeaderboard,
  type PlayerScoreInfo,
} from "../../src/ui/scoreLeaderboard";
import {
  createMinimap,
  SELECTED_DOT_HEX,
  type MinimapDeps,
} from "../../src/ui/minimap";
import {
  DIPLOMACY_STANCE_ALLY,
  DIPLOMACY_STANCE_ENEMY,
  DIPLOMACY_STANCE_NEUTRAL,
} from "../../src/sim/core/diplomacy";
import { RESOURCE_FOOD, RESOURCE_WOOD } from "../../src/sim/components/economy";
import { createWorld } from "../../src/sim/core/world";
import { defineSimComponents } from "../../src/sim/components";
import { createPlayerStockpile } from "../../src/sim/core/stockpile";
import type { WorldLayers } from "../../src/sim/world/layers";

// ---- Lightweight Mock DOM for Headless Testing -----------------------------------

class MockElement {
  readonly tagName: string;
  id = "";
  private _className = "";
  hidden = false;
  disabled = false;
  title = "";
  textContent = "";
  style: Record<string, string> = {};
  parentNode: MockElement | null = null;
  children: MockElement[] = [];
  private attributes = new Map<string, string>();
  private listeners: Record<string, ((e?: unknown) => void)[]> = {};

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get className(): string {
    return this._className;
  }

  set className(val: string) {
    this._className = val;
    this.classList._classes.clear();
    for (const c of val.split(/\s+/).filter(Boolean)) {
      this.classList._classes.add(c);
    }
  }

  classList = {
    _classes: new Set<string>(),
    add: (c: string) => {
      this.classList._classes.add(c);
      this._className = Array.from(this.classList._classes).join(" ");
    },
    remove: (c: string) => {
      this.classList._classes.delete(c);
      this._className = Array.from(this.classList._classes).join(" ");
    },
    contains: (c: string) => this.classList._classes.has(c),
  };

  get firstChild(): MockElement | null {
    return this.children[0] ?? null;
  }

  setAttribute(name: string, val: string): void {
    this.attributes.set(name, val);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild(child: MockElement): void {
    child.parentNode = this;
    this.children.push(child);
  }

  removeChild(child: MockElement): void {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
  }

  addEventListener(type: string, handler: (e?: unknown) => void): void {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type]!.push(handler);
  }

  dispatchEvent(event: { type: string; [key: string]: unknown }): void {
    const handlers = this.listeners[event.type];
    if (handlers) {
      for (const h of handlers) {
        h(event);
      }
    }
  }

  click(): void {
    this.dispatchEvent({ type: "click", target: this });
  }

  querySelector(selector: string): MockElement | null {
    for (const child of this.children) {
      if (matchesSelector(child, selector)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    for (const child of this.children) {
      if (matchesSelector(child, selector)) results.push(child);
      results.push(...child.querySelectorAll(selector));
    }
    return results;
  }
}

function matchesSelector(el: MockElement, selector: string): boolean {
  if (selector.startsWith("#")) {
    return el.id === selector.slice(1);
  }
  if (selector.startsWith(".")) {
    return el.classList.contains(selector.slice(1));
  }
  return el.tagName.toLowerCase() === selector.toLowerCase();
}

class MockCanvasContext {
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 1;
  globalAlpha = 1.0;
  rectCalls: {
    x: number;
    y: number;
    w: number;
    h: number;
    fill: string;
    alpha: number;
  }[] = [];
  path: { op: string; x?: number; y?: number }[] = [];
  drawImageCalls = 0;

  scale(_x: number, _y: number): void {}
  fillRect(x: number, y: number, w: number, h: number): void {
    this.rectCalls.push({
      x,
      y,
      w,
      h,
      fill: this.fillStyle,
      alpha: this.globalAlpha,
    });
  }
  beginPath(): void {
    this.path.push({ op: "beginPath" });
  }
  moveTo(x: number, y: number): void {
    this.path.push({ op: "moveTo", x, y });
  }
  lineTo(x: number, y: number): void {
    this.path.push({ op: "lineTo", x, y });
  }
  closePath(): void {
    this.path.push({ op: "closePath" });
  }
  stroke(): void {
    this.path.push({ op: "stroke" });
  }
  fill(): void {
    this.path.push({ op: "fill" });
  }
  drawImage(): void {
    this.drawImageCalls++;
  }
}

class MockCanvasElement extends MockElement {
  width = 176;
  height = 176;
  ctx = new MockCanvasContext();

  constructor() {
    super("canvas");
    this.style = { width: "176px", height: "176px", cursor: "crosshair" };
  }

  getContext(type: string): MockCanvasContext | null {
    if (type === "2d") return this.ctx;
    return null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 176, height: 176 };
  }
  setPointerCapture(): void {}
}

// ---- Test Suite ------------------------------------------------------------------

describe("Diplomacy & Tribute Panel (Issue #116 / S3)", () => {
  const origWindow = globalThis.window;
  const origDocument = globalThis.document;
  let mockBody: MockElement;
  let keydownListeners: ((e: { key: string }) => void)[] = [];

  beforeEach(() => {
    mockBody = new MockElement("body");
    keydownListeners = [];

    (globalThis as unknown as { document: unknown }).document = {
      body: mockBody,
      createElement: (tag: string) => {
        if (tag === "canvas") return new MockCanvasElement();
        return new MockElement(tag);
      },
    };

    (globalThis as unknown as { window: unknown }).window = {
      devicePixelRatio: 1,
      innerWidth: 1920,
      innerHeight: 1080,
      addEventListener: (
        type: string,
        handler: (e: { key: string }) => void,
      ) => {
        if (type === "keydown") keydownListeners.push(handler);
      },
      removeEventListener: vi.fn(),
    };
  });

  afterEach(() => {
    (globalThis as unknown as { document: unknown }).document = origDocument;
    (globalThis as unknown as { window: unknown }).window = origWindow;
  });

  const samplePlayers: PlayerDiplomacyInfo[] = [
    {
      playerId: 0,
      name: "Player 1",
      color: "#3b82f6",
      stance: DIPLOMACY_STANCE_ALLY,
      team: 0,
      status: "active",
      isHuman: true,
    },
    {
      playerId: 1,
      name: "Player 2",
      color: "#ef4444",
      stance: DIPLOMACY_STANCE_ENEMY,
      team: 1,
      status: "active",
      isHuman: false,
    },
    {
      playerId: 2,
      name: "Player 3",
      color: "#22c55e",
      stance: DIPLOMACY_STANCE_ALLY,
      team: 0,
      status: "active",
      isHuman: false,
    },
    {
      playerId: 3,
      name: "Player 4",
      color: "#eab308",
      stance: DIPLOMACY_STANCE_NEUTRAL,
      team: 2,
      status: "defeated",
      isHuman: false,
    },
  ];

  it("creates diplomacy panel hidden by default and mounts to document.body", () => {
    const callbacks: DiplomacyPanelCallbacks = {
      getPlayers: () => samplePlayers,
      onSetStance: vi.fn(),
      onSendTribute: vi.fn(),
      canAffordTribute: () => true,
    };

    const handle = createDiplomacyPanel(callbacks);
    expect(handle).toBeDefined();
    expect(handle.isOpen).toBe(false);
    expect(mockBody.children).toContain(handle.root);
  });

  it("toggles visibility and invokes onClose when hidden", () => {
    const onClose = vi.fn();
    const callbacks: DiplomacyPanelCallbacks = {
      getPlayers: () => samplePlayers,
      onSetStance: vi.fn(),
      onSendTribute: vi.fn(),
      canAffordTribute: () => true,
      onClose,
    };

    const handle = createDiplomacyPanel(callbacks);
    expect(handle.isOpen).toBe(false);

    handle.show();
    expect(handle.isOpen).toBe(true);

    handle.hide();
    expect(handle.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);

    handle.toggle();
    expect(handle.isOpen).toBe(true);

    handle.toggle();
    expect(handle.isOpen).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("closes panel on Escape keydown", () => {
    const callbacks: DiplomacyPanelCallbacks = {
      getPlayers: () => samplePlayers,
      onSetStance: vi.fn(),
      onSendTribute: vi.fn(),
      canAffordTribute: () => true,
    };

    const handle = createDiplomacyPanel(callbacks);
    handle.show();
    expect(handle.isOpen).toBe(true);

    for (const listener of keydownListeners) {
      listener({ key: "Escape" });
    }
    expect(handle.isOpen).toBe(false);
  });

  it("renders 4 players with correct status, names, and team designations", () => {
    const callbacks: DiplomacyPanelCallbacks = {
      getPlayers: () => samplePlayers,
      onSetStance: vi.fn(),
      onSendTribute: vi.fn(),
      canAffordTribute: () => true,
    };

    const handle = createDiplomacyPanel(callbacks);
    handle.show();

    const tbody = handle.root.querySelector("#diplomacy-tbody");
    expect(tbody).not.toBeNull();
    const rows = tbody!.querySelectorAll("tr");
    expect(rows.length).toBe(4);

    // Player 0 (Human, Team 1)
    expect(rows[0]!.className).toContain("player-self");
    const name0 = rows[0]!.querySelector(".player-name");
    expect(name0?.textContent).toBe("Player 1 (You)");
    const team0 = rows[0]!.querySelector(".td-team");
    expect(team0?.textContent).toBe("Team 1");

    // Human player has no stance buttons (dash)
    const selfStance = rows[0]!.querySelector(".stance-self");
    expect(selfStance?.textContent).toBe("—");

    // Player 3 (Defeated, Team 3)
    const status3 = rows[3]!.querySelector(".status-badge");
    expect(status3?.textContent).toBe("Defeated");
  });

  it("handles stance toggling via stance buttons and invokes onSetStance", () => {
    const onSetStance = vi.fn();
    const callbacks: DiplomacyPanelCallbacks = {
      getPlayers: () => samplePlayers,
      onSetStance,
      onSendTribute: vi.fn(),
      canAffordTribute: () => true,
    };

    const handle = createDiplomacyPanel(callbacks);
    handle.show();

    const tbody = handle.root.querySelector("#diplomacy-tbody");
    const rows = tbody!.querySelectorAll("tr");

    // Player 1 (Enemy AI) row has Ally, Neutral, Enemy stance buttons
    const stanceBtns = rows[1]!.querySelectorAll(".stance-btn");
    expect(stanceBtns.length).toBe(3);

    // Click 'Ally' button (first stance button)
    (stanceBtns[0] as HTMLButtonElement).click();
    expect(onSetStance).toHaveBeenCalledWith(1, DIPLOMACY_STANCE_ALLY);
  });

  it("handles tribute transfers and enforces canAffordTribute validation", () => {
    const onSendTribute = vi.fn();
    let foodBalance = 50; // Cannot afford 100 food

    const callbacks: DiplomacyPanelCallbacks = {
      getPlayers: () => samplePlayers,
      onSetStance: vi.fn(),
      onSendTribute,
      canAffordTribute: (code, amount) => {
        if (code === RESOURCE_FOOD) return foodBalance >= amount;
        return true;
      },
    };

    const handle = createDiplomacyPanel(callbacks);
    handle.show();

    const tbody = handle.root.querySelector("#diplomacy-tbody");
    const rows = tbody!.querySelectorAll("tr");

    // Player 1 tribute buttons
    const tribBtns = rows[1]!.querySelectorAll(".tribute-btn");
    expect(tribBtns.length).toBe(4);

    // Food button should be disabled because foodBalance < 100
    const foodBtn = tribBtns[0] as HTMLButtonElement;
    expect(foodBtn.disabled).toBe(true);

    // Wood button should be enabled
    const woodBtn = tribBtns[1] as HTMLButtonElement;
    expect(woodBtn.disabled).toBe(false);

    // Click wood tribute
    woodBtn.click();
    expect(onSendTribute).toHaveBeenCalledWith(1, RESOURCE_WOOD, 100);

    // Now give donor enough food and re-render
    foodBalance = 200;
    handle.render();

    const updatedRows = tbody!.querySelectorAll("tr");
    const updatedFoodBtn = updatedRows[1]!.querySelectorAll(
      ".tribute-btn",
    )[0] as HTMLButtonElement;
    expect(updatedFoodBtn.disabled).toBe(false);

    updatedFoodBtn.click();
    expect(onSendTribute).toHaveBeenCalledWith(1, RESOURCE_FOOD, 100);
  });

  it("disables tribute and stance buttons for defeated or surrendered players", () => {
    const callbacks: DiplomacyPanelCallbacks = {
      getPlayers: () => samplePlayers,
      onSetStance: vi.fn(),
      onSendTribute: vi.fn(),
      canAffordTribute: () => true,
    };

    const handle = createDiplomacyPanel(callbacks);
    handle.show();

    const tbody = handle.root.querySelector("#diplomacy-tbody");
    const rows = tbody!.querySelectorAll("tr");

    // Player 3 is defeated
    const stanceBtns = rows[3]!.querySelectorAll(".stance-btn");
    for (const btn of stanceBtns) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }

    // Tribute shows disabled dash
    const disabledTribute = rows[3]!.querySelector(".tribute-disabled");
    expect(disabledTribute).not.toBeNull();
  });
});

describe("Multi-Player Score Calculation & Leaderboard (Issue #116 / S3)", () => {
  const origDocument = globalThis.document;
  let mockBody: MockElement;

  beforeEach(() => {
    mockBody = new MockElement("body");
    (globalThis as unknown as { document: unknown }).document = {
      body: mockBody,
      createElement: (tag: string) => new MockElement(tag),
    };
  });

  afterEach(() => {
    (globalThis as unknown as { document: unknown }).document = origDocument;
  });

  it("calculates civilization score factoring economy, military, buildings, and age", () => {
    const world = createWorld(42);
    const comps = defineSimComponents(world);

    // Player 1 initial score with 200 food and 200 wood = 400 total * 0.2 = 80 econ score, age rank 1 = 0
    createPlayerStockpile(world, comps, 1, [200, 200, 0, 0, 0, 0, 0]);

    const baseScore = calculatePlayerScore(world, comps, 1);
    expect(baseScore).toBe(80);

    // Add 2 military units (combat rows: [eid, ownerId]) -> +50 score
    world.rowsByComponentId.set(
      comps.combatId,
      new Map([
        [10, [10, 1, 0, 0]],
        [11, [11, 1, 0, 0]],
      ]),
    );

    // Add 1 building (building rows: [ownerId, ...]) -> +35 score
    world.rowsByComponentId.set(comps.buildingId, new Map([[20, [1, 0, 0]]]));

    const scoreWithUnits = calculatePlayerScore(world, comps, 1);
    expect(scoreWithUnits).toBe(80 + 50 + 35); // 165
  });

  it("updates score leaderboard and sorts players descending by score", () => {
    const leaderboard = createScoreLeaderboard();
    expect(leaderboard.element).toBeDefined();

    const players: PlayerScoreInfo[] = [
      {
        playerId: 0,
        name: "Blue",
        color: "#3b82f6",
        score: 1200,
        ageRank: 2,
        status: "active",
      },
      {
        playerId: 1,
        name: "Red",
        color: "#ef4444",
        score: 1850,
        ageRank: 3,
        status: "active",
      },
      {
        playerId: 2,
        name: "Green",
        color: "#22c55e",
        score: 950,
        ageRank: 1,
        status: "active",
      },
      {
        playerId: 3,
        name: "Yellow",
        color: "#eab308",
        score: 400,
        ageRank: 1,
        status: "defeated",
      },
    ];

    leaderboard.update(players);

    const listEl = leaderboard.element.querySelector("#leaderboard-list");
    expect(listEl).not.toBeNull();
    const rows = listEl!.querySelectorAll(".leaderboard-row");
    expect(rows.length).toBe(4);

    // Sorted descending: Red (1850), Blue (1200), Green (950), Yellow (400)
    expect(rows[0]!.className).toContain("player-1");
    expect(rows[0]!.querySelector(".lb-score")?.textContent).toBe("1,850");
    expect(rows[0]!.querySelector(".lb-age-badge")?.textContent).toBe("III");

    expect(rows[1]!.className).toContain("player-0");
    expect(rows[1]!.querySelector(".lb-score")?.textContent).toBe("1,200");
    expect(rows[1]!.querySelector(".lb-age-badge")?.textContent).toBe("II");

    expect(rows[3]!.className).toContain("player-3");
    expect(rows[3]!.className).toContain("defeated");
    expect(rows[3]!.querySelector(".lb-score")?.textContent).toBe("400");
  });
});

describe("Minimap Multi-Player Color Rendering (Issue #116 / S3)", () => {
  const origWindow = globalThis.window;
  const origDocument = globalThis.document;
  const mockCanvases: MockCanvasElement[] = [];

  beforeEach(() => {
    mockCanvases.length = 0;
    (globalThis as unknown as { document: unknown }).document = {
      createElement: (tag: string) => {
        if (tag === "canvas") {
          const c = new MockCanvasElement();
          mockCanvases.push(c);
          return c;
        }
        return new MockElement(tag);
      },
      body: {
        appendChild: () => {},
      },
    };
    (globalThis as unknown as { window: unknown }).window = {
      innerWidth: 1920,
      innerHeight: 1080,
      devicePixelRatio: 1,
    };
  });

  afterEach(() => {
    (globalThis as unknown as { document: unknown }).document = origDocument;
    (globalThis as unknown as { window: unknown }).window = origWindow;
  });

  it("renders distinct player colors for all 4 players on minimap", () => {
    const size = 32;
    const fakeLayers: WorldLayers = {
      size,
      terrainType: new Uint8Array(size * size).fill(3), // grass
      elevationLevel: new Uint8Array(size * size).fill(0),
    } as unknown as WorldLayers;

    const playerColors: Record<number, string> = {
      0: "#3b82f6", // Blue
      1: "#ef4444", // Red
      2: "#22c55e", // Green
      3: "#eab308", // Yellow
    };

    const unitOwners: Record<number, number> = {
      100: 0,
      101: 1,
      102: 2,
      103: 3,
      104: 0, // Selected unit
    };

    const deps: MinimapDeps = {
      layers: fakeLayers,
      getFrame: () =>
        ({
          count: 5,
          eids: new Int32Array([100, 101, 102, 103, 104]),
          positions: new Float32Array([
            5,
            5, // P0
            10,
            10, // P1
            15,
            15, // P2
            20,
            20, // P3
            25,
            25, // P0 Selected
          ]),
        }) as unknown as ReturnType<MinimapDeps["getFrame"]>,
      isSelected: (eid) => eid === 104,
      fog: {
        isExplored: () => true,
        isVisible: () => true,
      },
      groundPointAt: () => ({ x: 16, y: 16 }),
      setCenter: vi.fn(),
      getBuildings: () => [
        { eid: 1, x: 4, y: 4, width: 3, height: 3, ownerId: 0 },
        { eid: 2, x: 9, y: 9, width: 3, height: 3, ownerId: 1 },
        { eid: 3, x: 14, y: 14, width: 3, height: 3, ownerId: 2 },
        { eid: 4, x: 19, y: 19, width: 3, height: 3, ownerId: 3 },
      ],
      getPlayerColor: (ownerId) => playerColors[ownerId] ?? "#ffffff",
      getUnitOwner: (eid) => unitOwners[eid] ?? 0,
    };

    const handle = createMinimap(deps);
    expect(handle).toBeDefined();

    handle.redraw();

    // The third canvas is the backBuffer (index 2); inspect the filled rects on it
    const backBuffer = mockCanvases[2]!;
    const fills = backBuffer.ctx.rectCalls.map((r) => r.fill);

    // Verify all 4 player colors were rendered for buildings and units
    expect(fills).toContain("#3b82f6"); // Blue
    expect(fills).toContain("#ef4444"); // Red
    expect(fills).toContain("#22c55e"); // Green
    expect(fills).toContain("#eab308"); // Yellow
    expect(fills).toContain(SELECTED_DOT_HEX); // White selection
  });
});

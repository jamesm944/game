/**
 * Title Screen & Skirmish Match Setup Interface Tests — Milestone F1 (Issue #139).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CIV_CARDS,
  DEFAULT_SKIRMISH_CONFIG,
  loadSavedSkirmishConfig,
  saveSkirmishConfig,
  createTitleScreen,
  type SkirmishMatchConfig,
} from "../../src/ui/titleScreen";
import { createPauseMenu } from "../../src/ui/pauseMenu";

function parseHtmlToMockElements(html: string, parent: MockElement): void {
  const tagRegex = /<!--[\s\S]*?-->|<(\/)?([a-zA-Z0-9-]+)([^>]*)>|([^<]+)/g;
  const stack: MockElement[] = [parent];
  const voidTags = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);

  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(html)) !== null) {
    const [fullMatch, isClosing, tagName, attrString, text] = match;

    if (fullMatch.startsWith("<!--")) {
      continue;
    }

    if (text !== undefined) {
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        const top = stack[stack.length - 1];
        if (top) {
          top.textContent = (top.textContent || "") + trimmed;
          if (top.tagName === "OPTION" && !top.value) {
            top.value = trimmed;
          }
        }
      }
      continue;
    }

    if (!tagName) continue;

    if (isClosing) {
      const lower = tagName.toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        const item = stack[i];
        if (item && item.tagName.toLowerCase() === lower) {
          stack.splice(i);
          break;
        }
      }
      continue;
    }

    // Opening tag
    const el = new MockElement(tagName);
    if (attrString) {
      const attrRegex =
        /([a-zA-Z0-9-:]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = attrRegex.exec(attrString)) !== null) {
        const name = attrMatch[1];
        if (!name) continue;
        const val = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "";
        if (name === "id") {
          el.id = val;
        } else if (name === "class") {
          el.className = val;
        } else if (name === "hidden") {
          el.hidden = true;
        } else if (name === "value") {
          el.value = val;
        } else if (name === "title") {
          el.title = val;
        } else if (name.startsWith("data-")) {
          const key = name.slice(5);
          el.dataset[key] = val;
          el.setAttribute(name, val);
        } else {
          el.setAttribute(name, val);
        }
      }
    }

    const currentParent = stack[stack.length - 1];
    if (currentParent) {
      currentParent.appendChild(el);
    }

    const isSelfClosing =
      fullMatch.endsWith("/>") || voidTags.has(tagName.toLowerCase());
    if (!isSelfClosing) {
      stack.push(el);
    }
  }
}

// Lightweight Mock DOM for node test environment
class MockElement {
  readonly tagName: string;
  id = "";
  private _className = "";
  hidden = false;
  disabled = false;
  title = "";
  textContent = "";
  private _innerHTML = "";
  value = "";
  style: Record<string, string> = {};
  parentNode: MockElement | null = null;
  children: MockElement[] = [];
  dataset: Record<string, string> = {};
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

  get innerHTML(): string {
    return this._innerHTML;
  }

  set innerHTML(html: string) {
    this._innerHTML = html;
    this.children = [];
    parseHtmlToMockElements(html, this);
  }

  classList = {
    _classes: new Set<string>(),
    add: (...classes: string[]) => {
      for (const c of classes) this.classList._classes.add(c);
      this._className = Array.from(this.classList._classes).join(" ");
    },
    remove: (...classes: string[]) => {
      for (const c of classes) this.classList._classes.delete(c);
      this._className = Array.from(this.classList._classes).join(" ");
    },
    contains: (c: string) => this.classList._classes.has(c),
    toggle: (c: string, force?: boolean) => {
      const state =
        force !== undefined ? force : !this.classList._classes.has(c);
      if (state) this.classList.add(c);
      else this.classList.remove(c);
      return state;
    },
  };

  appendChild<T extends MockElement>(child: T): T {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: (MockElement | string)[]): void {
    for (const n of nodes) {
      if (typeof n === "string") {
        this.textContent += n;
      } else {
        this.appendChild(n);
      }
    }
  }

  setAttribute(k: string, v: string): void {
    this.attributes.set(k, v);
  }

  getAttribute(k: string): string | null {
    return this.attributes.get(k) ?? null;
  }

  hasAttribute(k: string): boolean {
    return this.attributes.has(k);
  }

  removeAttribute(k: string): void {
    this.attributes.delete(k);
  }

  addEventListener(event: string, fn: (e?: unknown) => void): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
  }

  removeEventListener(event: string, fn: (e?: unknown) => void): void {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter((l) => l !== fn);
    }
  }

  dispatchEvent(event: { type: string; [k: string]: unknown }): boolean {
    const list = this.listeners[event.type];
    if (list) {
      for (const fn of list) fn(event);
    }
    return true;
  }

  click(): void {
    this.dispatchEvent({ type: "click", target: this });
  }

  querySelector<T extends MockElement = MockElement>(
    selector: string,
  ): T | null {
    if (selector.startsWith("#")) {
      const targetId = selector.slice(1);
      if (this.id === targetId) return this as unknown as T;
      for (const child of this.children) {
        const found = child.querySelector<T>(selector);
        if (found) return found;
      }
    } else if (selector.startsWith(".")) {
      const targetClass = selector.slice(1);
      if (this.classList.contains(targetClass)) return this as unknown as T;
      for (const child of this.children) {
        const found = child.querySelector<T>(selector);
        if (found) return found;
      }
    } else if (selector.includes("[data-")) {
      const match = selector.match(/\[([^\]=]+)(?:=["']?([^\]"']+)["']?)?\]/);
      if (match) {
        const attr = match[1]!;
        const val = match[2];
        const currentVal = this.getAttribute(attr);
        if (currentVal !== null && (val === undefined || currentVal === val)) {
          return this as unknown as T;
        }
      }
      for (const child of this.children) {
        const found = child.querySelector<T>(selector);
        if (found) return found;
      }
    } else {
      if (this.tagName.toLowerCase() === selector.toLowerCase())
        return this as unknown as T;
      for (const child of this.children) {
        const found = child.querySelector<T>(selector);
        if (found) return found;
      }
    }
    return null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const results: MockElement[] = [];
    const search = (node: MockElement) => {
      if (selector.startsWith(".")) {
        if (node.classList.contains(selector.slice(1))) results.push(node);
      } else if (selector.includes("[data-")) {
        const match = selector.match(/\[([^\]=]+)(?:=["']?([^\]"']+)["']?)?\]/);
        if (match) {
          const attr = match[1]!;
          const val = match[2];
          const currentVal = node.getAttribute(attr);
          if (
            currentVal !== null &&
            (val === undefined || currentVal === val)
          ) {
            results.push(node);
          }
        }
      } else if (node.tagName.toLowerCase() === selector.toLowerCase()) {
        results.push(node);
      }
      for (const child of node.children) search(child);
    };
    for (const child of this.children) search(child);
    return results;
  }
}

describe("Civilization Definitions & Skirmish Configuration", () => {
  it("defines all 4 asymmetric civilizations with unique units and techs", () => {
    expect(CIV_CARDS).toHaveLength(4);
    const ids = CIV_CARDS.map((c) => c.id);
    expect(ids).toEqual(["britons", "franks", "goths", "byzantines"]);

    const britons = CIV_CARDS.find((c) => c.id === "britons")!;
    expect(britons.name).toBe("Britons");
    expect(britons.uniqueUnit.name).toBe("Longbowman");
    expect(britons.uniqueTech.name).toBe("Yeomen");
    expect(britons.bonuses.length).toBeGreaterThanOrEqual(3);

    const franks = CIV_CARDS.find((c) => c.id === "franks")!;
    expect(franks.name).toBe("Franks");
    expect(franks.uniqueUnit.name).toBe("Throwing Axeman");
    expect(franks.uniqueTech.name).toBe("Chivalry");

    const goths = CIV_CARDS.find((c) => c.id === "goths")!;
    expect(goths.name).toBe("Goths");
    expect(goths.uniqueUnit.name).toBe("Huskarl");
    expect(goths.uniqueTech.name).toBe("Anarchy");

    const byzantines = CIV_CARDS.find((c) => c.id === "byzantines")!;
    expect(byzantines.name).toBe("Byzantines");
    expect(byzantines.uniqueUnit.name).toBe("Cataphract");
    expect(byzantines.uniqueTech.name).toContain("Greek Fire");
  });

  it("has valid default skirmish configuration", () => {
    expect(DEFAULT_SKIRMISH_CONFIG.playerCiv).toBe("britons");
    expect(DEFAULT_SKIRMISH_CONFIG.opponentCount).toBe(1);
    expect(DEFAULT_SKIRMISH_CONFIG.opponents).toHaveLength(3);
    expect(DEFAULT_SKIRMISH_CONFIG.startingAge).toBe(1);
    expect(DEFAULT_SKIRMISH_CONFIG.victoryCondition).toBe("standard");
  });

  it("serializes and deserializes skirmish config to storage with robust fallbacks", () => {
    const store = new Map<string, string>();
    const fakeStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    };

    const initial = loadSavedSkirmishConfig(fakeStorage);
    expect(initial.playerCiv).toBe("britons");

    const custom: SkirmishMatchConfig = {
      ...DEFAULT_SKIRMISH_CONFIG,
      playerCiv: "byzantines",
      opponentCount: 2,
      mapSize: 96,
      startingAge: 3,
    };
    saveSkirmishConfig(custom, fakeStorage);

    const loaded = loadSavedSkirmishConfig(fakeStorage);
    expect(loaded.playerCiv).toBe("byzantines");
    expect(loaded.opponentCount).toBe(2);
    expect(loaded.mapSize).toBe(96);
    expect(loaded.startingAge).toBe(3);

    // Corrupt fallback
    fakeStorage.setItem("ageofwind:skirmish_config", "not-json");
    const fallback = loadSavedSkirmishConfig(fakeStorage);
    expect(fallback.playerCiv).toBe("britons");
  });
});

describe("Title Screen Lifecycle & Navigation", () => {
  let originalDocument: unknown;
  let mockBody: MockElement;

  beforeEach(() => {
    originalDocument = global.document;
    mockBody = new MockElement("body");

    // Polyfill document.createElement for test
    (global as unknown as { document: unknown }).document = {
      createElement: (tag: string) => new MockElement(tag),
      body: mockBody,
    };
  });

  afterEach(() => {
    (global as unknown as { document: unknown }).document = originalDocument;
  });

  it("creates title screen and toggles views", () => {
    const onLaunchMatch = vi.fn();
    const handle = createTitleScreen({ onLaunchMatch });

    expect(handle.root).toBeDefined();
    expect(handle.isVisible).toBe(true);
    expect(handle.isOpen()).toBe(true);

    handle.showSetup();
    expect(
      handle.root.querySelector<HTMLElement>("#title-setup-view")?.hidden,
    ).toBe(false);

    handle.showCredits();
    expect(
      handle.root.querySelector<HTMLElement>("#title-credits-modal")?.hidden,
    ).toBe(false);

    handle.showTitle();
    expect(
      handle.root.querySelector<HTMLElement>("#title-main-view")?.hidden,
    ).toBe(false);

    handle.hide();
    expect(handle.isVisible).toBe(false);
    expect(handle.isOpen()).toBe(false);

    handle.show();
    expect(handle.isVisible).toBe(true);
  });

  it("integrates with pause menu Return to Main Menu action", async () => {
    const onExitToMainMenu = vi.fn();
    const pauseMenu = createPauseMenu({
      onResume: () => {},
      onSave: async () => {},
      onLoad: async () => {},
      onExport: async () => {},
      onDelete: async () => {},
      onImport: async () => {},
      onExportReplay: async () => {},
      onImportReplay: async () => {},
      listSlots: async () => [],
      onExitToMainMenu,
    });

    pauseMenu.show();
    expect(pauseMenu.isOpen).toBe(true);

    const returnBtn = pauseMenu.root.querySelector(
      "#pause-main-menu",
    ) as HTMLButtonElement | null;
    expect(returnBtn).toBeDefined();

    returnBtn?.click();
    expect(onExitToMainMenu).toHaveBeenCalledTimes(1);
    expect(pauseMenu.isOpen).toBe(false);
  });

  it("updates civilization and launches match with chosen config", () => {
    const onLaunchMatch = vi.fn();
    const handle = createTitleScreen({ onLaunchMatch });

    handle.showSetup();

    // Select Byzantines card
    const cards = Array.from(handle.root.querySelectorAll(".civ-card"));
    const byzantinesCard = cards.find(
      (c) => (c as HTMLElement).getAttribute("data-civ-id") === "byzantines",
    ) as HTMLElement | undefined;
    expect(byzantinesCard).toBeDefined();
    byzantinesCard?.dispatchEvent({ type: "click" } as unknown as Event);

    expect(handle.getConfig().playerCiv).toBe("byzantines");

    // Launch match
    vi.useFakeTimers();
    const launchBtn = handle.root.querySelector(
      "#setup-btn-launch",
    ) as HTMLElement | null;
    expect(launchBtn).toBeDefined();
    launchBtn?.dispatchEvent({ type: "click" } as unknown as Event);
    vi.advanceTimersByTime(400);

    expect(onLaunchMatch).toHaveBeenCalledTimes(1);
    const firstCall = onLaunchMatch.mock.calls[0];
    expect(firstCall).toBeDefined();
    const launchedConfig = (firstCall as [SkirmishMatchConfig])[0];
    expect(launchedConfig.playerCiv).toBe("byzantines");
    vi.useRealTimers();
  });

  it("supports audio toggle and continue match flow", () => {
    const onAudioToggle = vi.fn(() => true);
    const onContinueMatch = vi.fn();
    const handle = createTitleScreen({
      onAudioToggle,
      onContinueMatch,
    });

    // Test audio toggle
    const audioBtn = handle.root.querySelector(
      "#title-audio-toggle",
    ) as HTMLElement | null;
    expect(audioBtn).toBeDefined();
    audioBtn?.dispatchEvent({ type: "click" } as unknown as Event);
    expect(onAudioToggle).toHaveBeenCalledTimes(1);

    // Test continue button when match active
    handle.setHasActiveMatch(true);
    const continueBtn = handle.root.querySelector(
      "#menu-btn-continue",
    ) as HTMLElement | null;
    expect(continueBtn?.hasAttribute("disabled")).toBe(false);
    continueBtn?.dispatchEvent({ type: "click" } as unknown as Event);
    expect(onContinueMatch).toHaveBeenCalledTimes(1);
  });
});

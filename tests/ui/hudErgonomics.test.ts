/**
 * HUD Ergonomics and Layout Collision Resolution Tests — Issue #138 (H1).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatDrawStatsLine, createDevStatsHud } from "../../src/ui/devstats";
import { wireBuildMenu } from "../../src/ui/buildMenu";
import { createObjectiveHud } from "../../src/ui/objectiveHud";
import { createVictoryPathsPanel } from "../../src/ui/victoryPaths";

// Lightweight Mock DOM for node test environment
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

  replaceChildren(...nodes: (MockElement | string)[]): void {
    this.children = [];
    this.textContent = "";
    this.append(...nodes);
  }

  setAttribute(k: string, v: string): void {
    this.attributes.set(k, v);
  }

  getAttribute(k: string): string | null {
    return this.attributes.get(k) ?? null;
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

  dispatchEvent(e: { type: string; [key: string]: unknown }): boolean {
    const list = this.listeners[e.type] ?? [];
    for (const l of list) l(e);
    return true;
  }

  querySelector<T extends MockElement>(sel: string): T | null {
    if (sel.startsWith("#")) {
      const targetId = sel.slice(1);
      return (this.findDescendant((el) => el.id === targetId) as T) ?? null;
    }
    if (sel.startsWith(".")) {
      const targetClass = sel.slice(1);
      return (
        (this.findDescendant((el) =>
          el.classList.contains(targetClass),
        ) as T) ?? null
      );
    }
    return null;
  }

  private findDescendant(
    pred: (el: MockElement) => boolean,
  ): MockElement | null {
    for (const child of this.children) {
      if (pred(child)) return child;
      const deep = child.findDescendant(pred);
      if (deep) return deep;
    }
    return null;
  }
}

describe("Issue #138: HUD Ergonomics & Telemetry Gating", () => {
  const origDocument = globalThis.document;
  const origWindow = globalThis.window;
  let mockBody: MockElement;
  let keyListeners: Record<string, ((e: unknown) => void)[]> = {};

  beforeEach(() => {
    mockBody = new MockElement("body");
    keyListeners = {};

    globalThis.document = {
      createElement: (tag: string) => new MockElement(tag),
      body: mockBody,
    } as unknown as Document;

    globalThis.window = {
      addEventListener: (event: string, fn: (e: unknown) => void) => {
        if (!keyListeners[event]) keyListeners[event] = [];
        keyListeners[event].push(fn);
      },
      removeEventListener: (event: string, fn: (e: unknown) => void) => {
        if (keyListeners[event]) {
          keyListeners[event] = keyListeners[event].filter((l) => l !== fn);
        }
      },
    } as unknown as Window & typeof globalThis;
  });

  afterEach(() => {
    globalThis.document = origDocument;
    globalThis.window = origWindow;
  });

  describe("DevStats HUD Gating & Telemetry formatting", () => {
    it("formats draw stats line cleanly for integer and fractional frame rates", () => {
      expect(formatDrawStatsLine(45, 12000, 15)).toBe(
        "draws 45 · tris 12000 · anim 15 fps",
      );
      expect(formatDrawStatsLine(12, 4500, 7.5)).toBe(
        "draws 12 · tris 4500 · anim 7.5 fps",
      );
    });

    it("creates HUD hidden by default and toggles with F3", () => {
      const handle = createDevStatsHud();
      expect(handle.isVisible()).toBe(false);

      const devStatsEl = mockBody.querySelector("#dev-stats");
      expect(devStatsEl).not.toBeNull();
      expect(devStatsEl?.style.display).toBe("none");

      // While hidden, update does not manipulate DOM
      handle.update(50, 10000, 15);
      expect(devStatsEl?.textContent).toBe("");

      // Toggle visible
      handle.toggle();
      expect(handle.isVisible()).toBe(true);
      expect(devStatsEl?.style.display).toBe("block");
      expect(devStatsEl?.textContent).toBe(
        "draws 50 · tris 10000 · anim 15 fps",
      );

      // F3 key toggles
      const f3Event = {
        code: "F3",
        preventDefault: () => {},
        target: mockBody,
      };
      for (const listener of keyListeners["keydown"] ?? []) {
        listener(f3Event);
      }
      expect(handle.isVisible()).toBe(false);
      expect(devStatsEl?.style.display).toBe("none");
    });
  });

  describe("Build Menu Dock Modes & Header Toggle", () => {
    it("supports docked, adjacent, and hidden modes without DOM collisions", () => {
      const menu = wireBuildMenu({
        canAfford: () => true,
        onArm: () => {},
      });

      const menuEl = mockBody.querySelector("#build-menu");
      expect(menuEl).not.toBeNull();
      expect(menuEl?.classList.contains("dock-adjacent")).toBe(false);
      expect(menuEl?.classList.contains("hidden")).toBe(false);

      // Set adjacent mode
      menu.setDockMode("adjacent");
      expect(menuEl?.classList.contains("dock-adjacent")).toBe(true);
      expect(menuEl?.classList.contains("hidden")).toBe(false);

      // Set hidden mode
      menu.setDockMode("hidden");
      expect(menuEl?.classList.contains("hidden")).toBe(true);

      // Return to docked mode
      menu.setDockMode("docked");
      expect(menuEl?.classList.contains("dock-adjacent")).toBe(false);
      expect(menuEl?.classList.contains("hidden")).toBe(false);
    });

    it("collapses and expands via header toggle button and B key", () => {
      const menu = wireBuildMenu({
        canAfford: () => true,
        onArm: () => {},
      });

      const menuEl = mockBody.querySelector("#build-menu");
      expect(menu.isCollapsed()).toBe(false);

      menu.toggleCollapse();
      expect(menu.isCollapsed()).toBe(true);
      expect(menuEl?.classList.contains("collapsed")).toBe(true);

      // Pressing B toggles collapse
      const bEvent = {
        code: "KeyB",
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        target: mockBody,
      };
      for (const listener of keyListeners["keydown"] ?? []) {
        listener(bEvent);
      }
      expect(menu.isCollapsed()).toBe(false);
      expect(menuEl?.classList.contains("collapsed")).toBe(false);
    });
  });

  describe("Objective HUD Card Default State", () => {
    it("initializes with objective-hud--hidden to prevent empty card display", () => {
      const hud = createObjectiveHud();
      const card = mockBody.querySelector("#objective-hud");
      expect(card).not.toBeNull();
      expect(card?.classList.contains("objective-hud--hidden")).toBe(true);

      // When active objectives arrive, it reveals
      hud.update([
        {
          id: "obj-1",
          title: "Build Town Center",
          status: "active",
          primary: true,
        },
      ]);
      expect(card?.classList.contains("objective-hud--hidden")).toBe(false);

      // When cleared, it hides again
      hud.update([]);
      expect(card?.classList.contains("objective-hud--hidden")).toBe(true);
    });
  });

  describe("Victory Paths Panel Container & Collapsibility", () => {
    it("attaches cleanly to provided custom container and toggles", () => {
      const customContainer = new MockElement("div");
      customContainer.id = "top-left-hud-stack";
      mockBody.appendChild(customContainer);

      const panel = createVictoryPathsPanel({
        container: customContainer as unknown as HTMLElement,
      });
      panel.update([]);
      const vpEl = customContainer.querySelector("#victory-paths");
      expect(vpEl).not.toBeNull();

      const toggleBtn = vpEl?.querySelector(".victory-paths-toggle-btn");
      expect(toggleBtn).not.toBeNull();
      expect(toggleBtn?.textContent).toBe("−");

      toggleBtn?.dispatchEvent({ type: "click" });
      expect(vpEl?.classList.contains("collapsed")).toBe(true);
      expect(toggleBtn?.textContent).toBe("+");
    });
  });
});

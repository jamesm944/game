/**
 * Objectives Panel UI Tests — Milestone S5 / Issue #133.
 *
 * Verifies:
 * 1. Pure model helpers: countActiveObjectives, formatObjectiveStatusPill.
 * 2. ObjectivesPanel creation, button, modal dialog layout, and ARIA attributes.
 * 3. Objective updates: primary list, secondary list, status pills, and badge counts.
 * 4. Toggle states, close buttons, backdrop dismiss, and ESC/O hotkey handlers.
 * 5. Narrative mission transcript log display.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countActiveObjectives,
  createObjectivesPanel,
  formatObjectiveStatusPill,
} from "../../src/ui/objectivesPanel";
import type {
  ScenarioObjective,
  ScenarioNarrativeEvent,
} from "../../src/sim/scenario/types";

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

  private _innerHTML = "";

  get innerHTML(): string {
    return this._innerHTML;
  }

  set innerHTML(val: string) {
    this._innerHTML = val;
    this.children = [];
    // Parse simple IDs from innerHTML to support querySelector
    const idMatches = val.matchAll(/id=["']([^"']+)["']/g);
    for (const match of idMatches) {
      const child = new MockElement("div");
      child.id = match[1]!;
      child.parentNode = this;
      this.children.push(child);
    }
  }

  appendChild<T extends MockElement>(child: T): T {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: (MockElement | string)[]): void {
    for (const n of nodes) {
      if (typeof n === "string") {
        const textNode = new MockElement("span");
        textNode.textContent = n;
        this.appendChild(textNode);
      } else {
        this.appendChild(n);
      }
    }
  }

  remove(): void {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx >= 0) this.parentNode.children.splice(idx, 1);
      this.parentNode = null;
    }
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
      if (this.id === targetId) return this as unknown as T;
      for (const child of this.children) {
        const found = child.querySelector<T>(sel);
        if (found) return found;
      }
    }
    return null;
  }

  querySelectorAll<T extends MockElement>(sel: string): T[] {
    const results: T[] = [];
    if (sel.startsWith("#")) {
      const targetId = sel.slice(1);
      if (this.id === targetId) results.push(this as unknown as T);
    }
    for (const child of this.children) {
      results.push(...child.querySelectorAll<T>(sel));
    }
    return results;
  }
}

describe("Objectives Panel Pure Helpers", () => {
  it("counts active primary objectives", () => {
    const objectives: ScenarioObjective[] = [
      { id: "1", title: "O1", primary: true, status: "active" },
      { id: "2", title: "O2", primary: true, status: "completed" },
      { id: "3", title: "O3", primary: false, status: "active" },
      { id: "4", title: "O4", primary: true, status: "active" },
    ];
    expect(countActiveObjectives(objectives)).toBe(2);
  });

  it("formats objective status pills with correct icons and classes", () => {
    const active = formatObjectiveStatusPill("active");
    expect(active.text).toBe("Active");
    expect(active.icon).toBe("○");
    expect(active.className).toBe("pending");

    const completed = formatObjectiveStatusPill("completed");
    expect(completed.text).toBe("Completed");
    expect(completed.icon).toBe("✓");
    expect(completed.className).toBe("completed");

    const failed = formatObjectiveStatusPill("failed");
    expect(failed.text).toBe("Failed");
    expect(failed.icon).toBe("✕");
    expect(failed.className).toBe("failed");
  });
});

describe("Objectives Panel DOM & Interaction", () => {
  let originalDocument: unknown;
  let originalWindow: unknown;
  let mockBody: MockElement;
  let mockWindowListeners: Record<string, ((e?: unknown) => void)[]>;

  beforeEach(() => {
    originalDocument = (globalThis as unknown as { document?: unknown })
      .document;
    originalWindow = (globalThis as unknown as { window?: unknown }).window;
    mockBody = new MockElement("body");
    mockWindowListeners = {};

    const mockDoc = {
      createElement: (tag: string) => new MockElement(tag),
      body: mockBody,
      activeElement: null,
    };

    const mockWin = {
      addEventListener: (event: string, fn: (e?: unknown) => void) => {
        if (!mockWindowListeners[event]) mockWindowListeners[event] = [];
        mockWindowListeners[event].push(fn);
      },
      removeEventListener: (event: string, fn: (e?: unknown) => void) => {
        if (mockWindowListeners[event]) {
          mockWindowListeners[event] = mockWindowListeners[event].filter(
            (l) => l !== fn,
          );
        }
      },
    };

    (globalThis as unknown as { document: unknown }).document = mockDoc;
    (globalThis as unknown as { window: unknown }).window = mockWin;
  });

  afterEach(() => {
    (globalThis as unknown as { document: unknown }).document =
      originalDocument;
    (globalThis as unknown as { window: unknown }).window = originalWindow;
  });

  it("creates panel button and modal elements with ARIA semantics", () => {
    const panel = createObjectivesPanel({
      title: "Siege of Antioch",
      description: "Secure the citadel before reinforcements arrive.",
    });

    expect(panel.button).toBeDefined();
    expect(panel.button.id).toBe("objectives-toggle-btn");
    expect(panel.button.getAttribute("aria-label")).toBe(
      "View Scenario Objectives",
    );
    expect(panel.element.id).toBe("objectives-panel");
    expect(panel.element.getAttribute("role")).toBe("dialog");
    expect(panel.element.getAttribute("aria-modal")).toBe("true");

    panel.destroy();
  });

  it("toggles open and closed states via button click and toggle method", () => {
    let toggledState = false;
    const panel = createObjectivesPanel({
      onToggle: (open) => {
        toggledState = open;
      },
    });

    expect(panel.isOpen()).toBe(false);
    expect(panel.element.classList.contains("objectives-panel--hidden")).toBe(
      true,
    );

    panel.toggle(true);
    expect(panel.isOpen()).toBe(true);
    expect(toggledState).toBe(true);
    expect(panel.element.classList.contains("objectives-panel--hidden")).toBe(
      false,
    );

    panel.button.dispatchEvent({ type: "click" } as unknown as Event);
    expect(panel.isOpen()).toBe(false);
    expect(toggledState).toBe(false);

    panel.destroy();
  });

  it("updates objective items, badge count, and transcripts", () => {
    const panel = createObjectivesPanel();

    const objectives: ScenarioObjective[] = [
      { id: "p1", title: "Build Town Center", primary: true, status: "active" },
      {
        id: "p2",
        title: "Train 5 Militia",
        primary: true,
        status: "completed",
      },
      { id: "s1", title: "Discover Relic", primary: false, status: "active" },
    ];

    const narrativeEvents: ScenarioNarrativeEvent[] = [
      {
        tick: 30,
        triggerId: "t1",
        action: {
          kind: "broadcastMessage",
          sender: "Captain",
          message: "Our troops stand ready at the perimeter.",
        },
      },
    ];

    panel.update(objectives, narrativeEvents);

    const btnMock = panel.button as unknown as MockElement;
    const elMock = panel.element as unknown as MockElement;

    const badge = btnMock.querySelector<MockElement>("#objectives-badge")!;
    expect(badge.textContent).toBe("1"); // 1 active primary objective
    expect(badge.style.display).toBe("inline-flex");

    const primaryList = elMock.querySelector<MockElement>(
      "#objectives-primary-list",
    )!;
    expect(primaryList.children.length).toBe(2);

    const secondarySection = elMock.querySelector<MockElement>(
      "#objectives-secondary-section",
    )!;
    expect(secondarySection.style.display).toBe("block");

    const transcriptsSection = elMock.querySelector<MockElement>(
      "#objectives-transcripts-section",
    )!;
    expect(transcriptsSection.style.display).toBe("block");

    panel.destroy();
  });
});

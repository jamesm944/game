/**
 * Tests for in-game notification toasts & alerts — V14 / Issue #104.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createToastManager,
  formatAgeUpMessage,
  formatIdleVillagerMessage,
  formatResearchCompleteMessage,
  formatUnderAttackMessage,
  formatUnitIdleMessage,
  getIconForKind,
  type ToastManager,
} from "../src/ui/toasts";

/** Lightweight Mock HTMLElement for headless Vitest testing. */
class MockElement {
  id = "";
  innerHTML = "";
  textContent = "";
  parentNode: MockElement | null = null;
  children: MockElement[] = [];
  listeners: Record<string, ((e?: unknown) => void)[]> = {};
  attributes = new Map<string, string>();

  _className = "";
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

  addEventListener(
    type: string,
    handler: (e?: unknown) => void,
    _opts?: unknown,
  ): void {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type]!.push(handler);
  }

  click(): void {
    for (const h of this.listeners["click"] ?? []) {
      h();
    }
  }

  querySelector(selector: string): MockElement | null {
    if (selector.startsWith("[data-toast-id=\"")) {
      const id = selector.slice(16, -2);
      for (const child of this.children) {
        if (child.getAttribute("data-toast-id") === id) return child;
      }
    }
    return null;
  }

  querySelectorAll(selector: string): MockElement[] {
    if (selector === ".game-toast") {
      return this.children.filter((c) =>
        c.classList.contains("game-toast"),
      );
    }
    return [];
  }
}

describe("Toast Notification Formatters (Issue #104)", () => {
  it("formats under-attack message and subtitle", () => {
    const res = formatUnderAttackMessage("Barracks under fire");
    expect(res.message).toBe("⚔ Under attack!");
    expect(res.subtitle).toBe("Barracks under fire");

    const def = formatUnderAttackMessage();
    expect(def.message).toBe("⚔ Under attack!");
    expect(def.subtitle).toBe("Units or buildings taking damage");
  });

  it("formats research-complete message", () => {
    expect(formatResearchCompleteMessage("Iron Casting")).toBe(
      "✓ Iron Casting researched",
    );
    expect(formatResearchCompleteMessage("Bodkin Arrow")).toBe(
      "✓ Bodkin Arrow researched",
    );
  });

  it("formats age-up message", () => {
    expect(formatAgeUpMessage("Castle Age")).toBe("⚜ Castle Age reached!");
    expect(formatAgeUpMessage("Imperial Age")).toBe("⚜ Imperial Age reached!");
  });

  it("formats unit-idle message", () => {
    const res = formatUnitIdleMessage("Knight");
    expect(res.message).toBe("💤 Military unit idle");
    expect(res.subtitle).toBe("Knight");
  });

  it("formats idle-villager message correctly for single and multiple workers", () => {
    const single = formatIdleVillagerMessage(1);
    expect(single.message).toBe("💤 1 villager idle");
    expect(single.subtitle).toBe("Click to jump and assign tasks");

    const multi = formatIdleVillagerMessage(3);
    expect(multi.message).toBe("💤 3 villagers idle");

    const custom = formatIdleVillagerMessage(2, "Gold vein exhausted");
    expect(custom.message).toBe("💤 2 villagers idle");
    expect(custom.subtitle).toBe("Gold vein exhausted");
  });

  it("provides distinct SVG icons for every toast kind", () => {
    const attackIcon = getIconForKind("under-attack");
    const techIcon = getIconForKind("research-complete");
    const ageIcon = getIconForKind("age-up");
    const idleIcon = getIconForKind("unit-idle");
    const idleVillagerIcon = getIconForKind("idle-villager");
    const genericIcon = getIconForKind("generic");

    expect(idleVillagerIcon).toContain("<svg");
    expect(idleVillagerIcon).toContain("#f59e0b");

    expect(attackIcon).toContain("<svg");
    expect(attackIcon).toContain("#ef4444"); // danger red

    expect(techIcon).toContain("<svg");
    expect(techIcon).toContain("#10b981"); // success emerald

    expect(ageIcon).toContain("<svg");
    expect(ageIcon).toContain("#f59e0b"); // golden amber

    expect(idleIcon).toContain("<svg");
    expect(idleIcon).toContain("#60a5fa"); // blue

    expect(genericIcon).toContain("<svg");
  });
});

describe("Toast Notification Manager with Mock DOM", () => {
  let mockContainer: MockElement;
  let toastManager: ToastManager;

  beforeEach(() => {
    vi.useFakeTimers();
    mockContainer = new MockElement();
    mockContainer.id = "game-toast-container";
    mockContainer.setAttribute("role", "status");
    mockContainer.setAttribute("aria-live", "polite");

    // Stub document.createElement for toasts
    (globalThis as unknown as { document: { createElement: () => HTMLElement } }).document = {
      createElement: () => new MockElement() as unknown as HTMLElement,
    };
  });

  afterEach(() => {
    toastManager?.destroy();
    vi.useRealTimers();
  });

  it("creates a container with ARIA live-region attributes", () => {
    toastManager = createToastManager({
      container: mockContainer as unknown as HTMLElement,
    });
    expect(toastManager.container.getAttribute("role")).toBe("status");
    expect(toastManager.container.getAttribute("aria-live")).toBe("polite");
  });

  it("renders an under-attack toast and triggers onJumpTo on click", () => {
    const onJumpTo = vi.fn();
    toastManager = createToastManager({
      container: mockContainer as unknown as HTMLElement,
      onJumpTo,
    });

    const id = toastManager.show({
      kind: "under-attack",
      message: "⚔ Under attack!",
      subtitle: "Town Center taking damage",
      location: { x: 25, y: 30 },
      durationMs: 4000,
    });

    const toastEl = (mockContainer as unknown as MockElement).querySelector(
      `[data-toast-id="${id}"]`,
    );
    expect(toastEl).not.toBeNull();
    expect(toastEl?.classList.contains("game-toast-under-attack")).toBe(true);
    expect(toastEl?.classList.contains("game-toast-clickable")).toBe(true);

    // Clicking fires onJumpTo with location coordinates
    toastEl?.click();
    expect(onJumpTo).toHaveBeenCalledWith(25, 30);
  });

  it("throttles under-attack notifications within the throttle interval", () => {
    toastManager = createToastManager({
      container: mockContainer as unknown as HTMLElement,
      attackThrottleMs: 4000,
    });

    // First call fires
    const first = toastManager.notifyUnderAttack(10, 10, "Barracks under attack");
    expect(first).toBe(true);
    expect(mockContainer.children.length).toBe(1);

    // Immediate second call is throttled
    const second = toastManager.notifyUnderAttack(10, 10, "Barracks under attack");
    expect(second).toBe(false);
    expect(mockContainer.children.length).toBe(1);

    // Advance 2 seconds (still throttled)
    vi.advanceTimersByTime(2000);
    const third = toastManager.notifyUnderAttack(10, 10, "Barracks under attack");
    expect(third).toBe(false);

    // Advance past 4 seconds total
    vi.advanceTimersByTime(2500);
    const fourth = toastManager.notifyUnderAttack(10, 10, "Barracks under attack");
    expect(fourth).toBe(true);
    expect(mockContainer.children.length).toBe(1);
  });

  it("auto-dismisses toasts after the specified duration", () => {
    toastManager = createToastManager({
      container: mockContainer as unknown as HTMLElement,
    });

    toastManager.show({
      kind: "research-complete",
      message: "✓ Iron Casting researched",
      durationMs: 3000,
    });

    expect(mockContainer.children.length).toBe(1);

    // Advance past duration + fallback removal delay
    vi.advanceTimersByTime(3500);
    expect(mockContainer.children.length).toBe(0);
  });

  it("limits maximum simultaneous visible toasts to 4", () => {
    toastManager = createToastManager({
      container: mockContainer as unknown as HTMLElement,
    });

    for (let i = 1; i <= 6; i++) {
      toastManager.show({
        kind: "generic",
        message: `Notification ${i}`,
      });
    }

    // Dismissal fallback removes oldest items
    vi.advanceTimersByTime(500);
    expect(mockContainer.children.length).toBeLessThanOrEqual(4);
  });

  it("clears all toasts cleanly", () => {
    toastManager = createToastManager({
      container: mockContainer as unknown as HTMLElement,
    });
    toastManager.show({ kind: "generic", message: "Toast 1" });
    toastManager.show({ kind: "generic", message: "Toast 2" });
    expect(mockContainer.children.length).toBe(2);

    toastManager.clear();
    vi.advanceTimersByTime(500);
    expect(mockContainer.children.length).toBe(0);
  });

  it("notifies farm exhausted with kind and location", () => {
    toastManager = createToastManager({
      container: mockContainer as unknown as HTMLElement,
    });
    const result = toastManager.notifyFarmExhausted(
      15,
      20,
      "Insufficient wood to reseed farm",
    );
    expect(result).toBe(true);
    expect(mockContainer.children.length).toBe(1);
    expect(mockContainer.children[0]!.className).toContain("game-toast-farm-exhausted");
  });

  it("notifies idle villager with kind, location and camera jump click handling", () => {
    const onJumpTo = vi.fn();
    toastManager = createToastManager({
      container: mockContainer as unknown as HTMLElement,
      onJumpTo,
      idleThrottleMs: 6000,
    });

    const fired = toastManager.notifyIdleVillager(42, 58, 2, "Wood depleted");
    expect(fired).toBe(true);
    expect(mockContainer.children.length).toBe(1);

    const toastEl = mockContainer.children[0]!;
    expect(toastEl.className).toContain("game-toast-idle-villager");
    expect(toastEl.className).toContain("game-toast-clickable");

    toastEl.click();
    expect(onJumpTo).toHaveBeenCalledWith(42, 58);

    // Throttled within interval
    const throttled = toastManager.notifyIdleVillager(42, 58, 2);
    expect(throttled).toBe(false);

    // Unthrottled after interval
    vi.advanceTimersByTime(6500);
    const retry = toastManager.notifyIdleVillager(42, 58, 1);
    expect(retry).toBe(true);
  });
});

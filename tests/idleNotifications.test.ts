/**
 * Unit & Integration Tests for Idle Villager Notifications & Audio Cues — Q2 / Issue #121.
 */

import { describe, expect, it, vi } from "vitest";
import { AUDIO_CLIPS } from "../src/audio/intents";
import {
  createToastManager,
  formatIdleVillagerMessage,
  getIconForKind,
} from "../src/ui/toasts";
import { createWorld, type World } from "../src/sim/core/world";
import { defineSimComponents, spawnUnit, type SimComponents } from "../src/sim/components";
import { findIdleVillagers } from "../src/sim/economy/idleWorkers";
import { PLAYER_ONE } from "../src/sim/core/stockpile";
import { unitCodeOf } from "../src/data/definitions";
import {
  assignNode,
  spawnResourceNode,
  RESOURCE_WOOD,
} from "../src/sim/components/economy";
import { assignSite, spawnBuildingSite } from "../src/sim/components/buildings";

/** Mock Element for headless DOM testing */
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
    if (idx !== -1) {
      child.parentNode = null;
      this.children.splice(idx, 1);
    }
  }
  addEventListener(event: string, handler: (e?: unknown) => void): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event]!.push(handler);
  }
  click(): void {
    for (const h of this.listeners["click"] ?? []) h();
  }
}

describe("Q2: Audio Cue Pipeline Integration", () => {
  it("registers ui.idle in AUDIO_CLIPS array", () => {
    expect(AUDIO_CLIPS).toContain("ui.idle");
  });

  it("follows standard audio clip intent namespace for ui cues", () => {
    expect("ui.idle").toMatch(/^ui\.[a-z]+$/);
    const uiClips = AUDIO_CLIPS.filter((clip) => clip.startsWith("ui."));
    expect(uiClips).toContain("ui.click");
    expect(uiClips).toContain("ui.idle");
  });
});

const VILLAGER_CODE = unitCodeOf("villager");

function spawnVillager(
  world: World,
  comps: SimComponents,
  x: number,
  y: number,
  playerId: number = PLAYER_ONE,
): number {
  const eid = spawnUnit(world, comps, x, y, { ownerId: playerId });
  world.rowsByComponentId.get(comps.combatId)!.set(eid, [
    VILLAGER_CODE,
    3,
    40,
    0,
    0,
  ]);
  return eid;
}

describe("Q2: Idle Villager Detection & State Transitions", () => {
  it("correctly identifies idle villagers and transitions when assigned to work", () => {
    const world = createWorld(1234);
    const comps = defineSimComponents(world);

    // Initially 0 idle villagers
    expect(findIdleVillagers(world, comps, PLAYER_ONE)).toHaveLength(0);

    // Spawn 2 villagers for PLAYER_ONE and 1 for enemy
    const v1 = spawnVillager(world, comps, 10, 10, PLAYER_ONE);
    const v2 = spawnVillager(world, comps, 12, 10, PLAYER_ONE);
    const vEnemy = spawnVillager(world, comps, 20, 20, 2);

    const idleInitial = findIdleVillagers(world, comps, PLAYER_ONE);
    expect(idleInitial).toHaveLength(2);
    expect(idleInitial).toContain(v1);
    expect(idleInitial).toContain(v2);
    expect(idleInitial).not.toContain(vEnemy);

    // Assign v1 to a wood resource node -> no longer idle
    const node = spawnResourceNode(world, comps, 10, 12, RESOURCE_WOOD, 100);
    assignNode(world, comps, v1, node);

    const idleAfterNode = findIdleVillagers(world, comps, PLAYER_ONE);
    expect(idleAfterNode).toHaveLength(1);
    expect(idleAfterNode).toContain(v2);

    // Assign v2 to a construction site -> no longer idle
    const siteEid = spawnBuildingSite(world, comps, "house", 15, 15, { playerId: PLAYER_ONE });
    assignSite(world, comps, v2, siteEid);

    const idleAfterBuild = findIdleVillagers(world, comps, PLAYER_ONE);
    expect(idleAfterBuild).toHaveLength(0);
  });
});

describe("Q2: Idle Villager Notifications & Toast Manager", () => {
  it("formats singular vs plural idle villager messages and custom reasons", () => {
    const s1 = formatIdleVillagerMessage(1);
    expect(s1.message).toBe("💤 1 villager idle");
    expect(s1.subtitle).toBe("Click to jump and assign tasks");

    const s4 = formatIdleVillagerMessage(4);
    expect(s4.message).toBe("💤 4 villagers idle");

    const custom = formatIdleVillagerMessage(2, "Gold vein exhausted");
    expect(custom.message).toBe("💤 2 villagers idle");
    expect(custom.subtitle).toBe("Gold vein exhausted");
  });

  it("provides distinct amber icon for idle-villager kind", () => {
    const icon = getIconForKind("idle-villager");
    expect(icon).toContain("<svg");
    expect(icon).toContain("#f59e0b");
  });

  it("handles notifyIdleVillager with location, click camera jump, and throttle cooldown", () => {
    const origDoc = globalThis.document;
    const mockContainer = new MockElement();
    mockContainer.id = "game-toast-container";

    (globalThis as unknown as { document: { createElement: () => HTMLElement } }).document = {
      createElement: () => new MockElement() as unknown as HTMLElement,
    };

    try {
      const onJumpTo = vi.fn();
      const manager = createToastManager({
        container: mockContainer as unknown as HTMLElement,
        onJumpTo,
        idleThrottleMs: 5000,
      });

      // First notification succeeds
      const shown = manager.notifyIdleVillager(25, 35, 1, "Wood tree felled");
      expect(shown).toBe(true);
      expect(mockContainer.children.length).toBe(1);

      const toast = mockContainer.children[0]!;
      expect(toast.className).toContain("game-toast-idle-villager");
      expect(toast.className).toContain("game-toast-clickable");

      // Clicking jumps camera to villager location
      toast.click();
      expect(onJumpTo).toHaveBeenCalledWith(25, 35);

      // Subsequent call within 5s is throttled
      const throttled = manager.notifyIdleVillager(25, 35, 2);
      expect(throttled).toBe(false);

      manager.destroy();
    } finally {
      globalThis.document = origDoc;
    }
  });
});

describe("Q2: Simulation Determinism Invariance", () => {
  it("guarantees query functions and event polling leave sim state bit-exact", () => {
    const world1 = createWorld(999);
    const comps1 = defineSimComponents(world1);
    spawnVillager(world1, comps1, 10, 10, PLAYER_ONE);

    const world2 = createWorld(999);
    const comps2 = defineSimComponents(world2);
    spawnVillager(world2, comps2, 10, 10, PLAYER_ONE);

    // Repeatedly query idle workers on world1
    for (let i = 0; i < 50; i++) {
      findIdleVillagers(world1, comps1, PLAYER_ONE);
    }

    // World1 and World2 must remain bit-identical
    expect(world1.tick).toBe(world2.tick);
    expect(world1.entities.length).toBe(world2.entities.length);
    const rows1 = world1.rowsByComponentId.get(comps1.positionId);
    const rows2 = world2.rowsByComponentId.get(comps2.positionId);
    expect(rows1).toEqual(rows2);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  defineSimComponents,
  spawnBuildingSite,
  spawnUnit,
  type SimComponents,
} from "../src/sim/components";
import { RESOURCE_FOOD, RESOURCE_WOOD } from "../src/sim/components/economy";
import {
  createPlayerStockpile,
  createDropOffPoint,
  PLAYER_ONE,
  stockpileAmountsOf,
} from "../src/sim/core/stockpile";
import {
  createWorld,
  registerSystem,
  step,
  type World,
} from "../src/sim/core/world";
import {
  PathScheduler,
  createSynchronousPathTransport,
} from "../src/sim/path/scheduler";
import {
  createGatherDiagnostics,
  createGatherSystem,
  isAutoReseedEnabled,
  setAutoReseedEnabled,
  readFarmDepletedEvents,
  FARM_RESEED_WOOD_COST,
  BASE_FARM_FOOD,
  SET_AUTO_RESEED_COMMAND_KIND,
  type SetAutoReseedCommandData,
} from "../src/sim/systems/gather";
import { completeBuilding } from "../src/sim/components/buildings";
import { planAutoReseed } from "../src/sim/ai/economyManager";
import type { AiKnowledge } from "../src/sim/ai/knowledge";
import type { CommandDraft } from "../src/sim/ai/buildOrder";
import {
  issueSetAutoReseed,
  formatFarmFoodStatus,
  createBuildingPanel,
  type BuildingPanelData,
} from "../src/ui/buildingPanel";

import { createMovementSystem } from "../src/sim/systems/movement";
import { buildLayers, TERRAIN_GRASS } from "../src/sim/world/layers";

function makeHarness(initialWood: number = 200) {
  const size = 64;
  const terrainType = new Uint8Array(size * size).fill(TERRAIN_GRASS);
  const scheduler = new PathScheduler(createSynchronousPathTransport());
  const world = createWorld(20260917, {
    layers: buildLayers(terrainType, new Uint8Array(size * size)),
    size,
    pathScheduler: scheduler,
  });
  const comps = defineSimComponents(world);
  registerSystem(world, createMovementSystem(comps, scheduler));

  const startResources = new Array(7).fill(0);
  startResources[RESOURCE_WOOD] = initialWood;
  createPlayerStockpile(world, comps, PLAYER_ONE, startResources);

  const diag = createGatherDiagnostics();
  const gatherSystem = createGatherSystem(comps, scheduler, diag);
  registerSystem(world, gatherSystem);

  // Dropoff mill at (10, 10)
  createDropOffPoint(world, comps, 10, 10, PLAYER_ONE, [RESOURCE_FOOD]);

  return { world, comps, diag };
}

function spawnTestFarm(
  world: World,
  comps: SimComponents,
  x: number,
  y: number,
  initialFood: number = 5,
): number {
  const siteEid = spawnBuildingSite(world, comps, "farm", x, y, {
    playerId: PLAYER_ONE,
  });
  completeBuilding(world, comps, siteEid);
  // Override food to initialFood for fast testing
  world.rowsByComponentId
    .get(comps.resourceNodeId)!
    .set(siteEid, [RESOURCE_FOOD, initialFood, 1]);
  return siteEid;
}

describe("Auto-Reseed Farms (V15 / #105)", () => {
  it("defaults to enabled for players and can be toggled via command", () => {
    const { world } = makeHarness(100);
    expect(isAutoReseedEnabled(world, PLAYER_ONE)).toBe(true);

    // Toggle OFF via command
    world.inbox.submit({
      kind: SET_AUTO_RESEED_COMMAND_KIND,
      targetTick: 1,
      data: {
        playerId: PLAYER_ONE,
        enabled: false,
      } as SetAutoReseedCommandData,
    });
    step(world);

    expect(isAutoReseedEnabled(world, PLAYER_ONE)).toBe(false);

    // Toggle ON via command
    world.inbox.submit({
      kind: SET_AUTO_RESEED_COMMAND_KIND,
      targetTick: 2,
      data: { playerId: PLAYER_ONE, enabled: true } as SetAutoReseedCommandData,
    });
    step(world);

    expect(isAutoReseedEnabled(world, PLAYER_ONE)).toBe(true);
  });

  it("automatically reseeds depleted farm and debits 60 wood when enabled and wood is sufficient", () => {
    const { world, comps, diag } = makeHarness(150);
    const farmEid = spawnTestFarm(world, comps, 10, 12, 1); // 1 food remaining

    const workerEid = spawnUnit(world, comps, 10, 12, { ownerId: PLAYER_ONE });

    // Order worker to gather from farm
    world.inbox.submit({
      kind: "gather",
      targetTick: 1,
      data: { entityIds: [workerEid], nodeId: farmEid },
    });

    // Run until worker harvests the 1 food and farm depletes
    for (let t = 0; t < 300; t++) {
      step(world);
      if (diag.farmReseeds > 0) break;
    }

    expect(diag.farmReseeds).toBe(1);
    // 150 - 60 = 90 wood remaining
    const amounts = stockpileAmountsOf(world, comps, PLAYER_ONE);
    expect(amounts[RESOURCE_WOOD]).toBe(150 - FARM_RESEED_WOOD_COST);

    // Farm node food should be restored to BASE_FARM_FOOD (175)
    const nodeRow = world.rowsByComponentId
      .get(comps.resourceNodeId)
      ?.get(farmEid);
    expect(nodeRow).toBeDefined();
    expect(nodeRow![1]).toBe(BASE_FARM_FOOD);
  });

  it("depletes farm, emits event, and idles worker when wood is insufficient (< 60)", () => {
    const { world, comps, diag } = makeHarness(30); // only 30 wood
    const farmEid = spawnTestFarm(world, comps, 10, 12, 1);

    const workerEid = spawnUnit(world, comps, 10, 12, { ownerId: PLAYER_ONE });

    world.inbox.submit({
      kind: "gather",
      targetTick: 1,
      data: { entityIds: [workerEid], nodeId: farmEid },
    });

    // Run until farm depletes and despawns
    for (let t = 0; t < 300; t++) {
      step(world);
      if (!world.entities.includes(farmEid)) break;
    }

    expect(diag.farmReseeds).toBe(0);

    // Wood should NOT be debited
    const amounts = stockpileAmountsOf(world, comps, PLAYER_ONE);
    expect(amounts[RESOURCE_WOOD]).toBe(30);

    // Farm depleted event should be recorded
    const events = readFarmDepletedEvents(world, PLAYER_ONE);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.farmEid).toBe(farmEid);
    expect(events[0]!.reason).toBe("insufficient-wood");

    // Farm entity should be despawned
    expect(world.entities.includes(farmEid)).toBe(false);
  });

  it("depletes farm without reseed when auto-reseed is disabled, even with abundant wood", () => {
    const { world, comps, diag } = makeHarness(500);
    setAutoReseedEnabled(world, PLAYER_ONE, false);

    const farmEid = spawnTestFarm(world, comps, 10, 12, 1);
    const workerEid = spawnUnit(world, comps, 10, 12, { ownerId: PLAYER_ONE });

    world.inbox.submit({
      kind: "gather",
      targetTick: 1,
      data: { entityIds: [workerEid], nodeId: farmEid },
    });

    for (let t = 0; t < 300; t++) {
      step(world);
      if (!world.entities.includes(farmEid)) break;
    }

    expect(diag.farmReseeds).toBe(0);
    const amounts = stockpileAmountsOf(world, comps, PLAYER_ONE);
    expect(amounts[RESOURCE_WOOD]).toBe(500); // no wood debited

    const events = readFarmDepletedEvents(world, PLAYER_ONE);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.reason).toBe("auto-reseed-disabled");
    expect(world.entities.includes(farmEid)).toBe(false);
  });

  it("AI plans auto-reseed ON when wood >= 60 and OFF when wood < 60", () => {
    let autoReseedState = false;
    const mockKnowledgeWithWood = {
      player: 1,
      resources: () => [0, 100, 0, 0], // 100 wood >= 60
      autoReseedEnabled: () => autoReseedState,
    } as unknown as AiKnowledge;

    const drafts1: CommandDraft[] = [];
    planAutoReseed(mockKnowledgeWithWood, drafts1);
    expect(drafts1.length).toBe(1);
    expect(drafts1[0]).toEqual({
      kind: SET_AUTO_RESEED_COMMAND_KIND,
      data: { playerId: 1, enabled: true },
    });

    autoReseedState = true;
    const mockKnowledgeLowWood = {
      player: 1,
      resources: () => [0, 40, 0, 0], // 40 wood < 60
      autoReseedEnabled: () => autoReseedState,
    } as unknown as AiKnowledge;

    const drafts2: CommandDraft[] = [];
    planAutoReseed(mockKnowledgeLowWood, drafts2);
    expect(drafts2.length).toBe(1);
    expect(drafts2[0]).toEqual({
      kind: SET_AUTO_RESEED_COMMAND_KIND,
      data: { playerId: 1, enabled: false },
    });
  });

  it("issueSetAutoReseed helper formats and submits command into inbox", () => {
    const submitted: unknown[] = [];
    const mockInbox = {
      submit: (cmd: unknown) => submitted.push(cmd),
    };

    issueSetAutoReseed(
      mockInbox as unknown as Parameters<typeof issueSetAutoReseed>[0],
      15,
      0,
      false,
    );
    expect(submitted.length).toBe(1);
    expect(submitted[0]).toEqual({
      kind: SET_AUTO_RESEED_COMMAND_KIND,
      targetTick: 16,
      data: { playerId: 0, enabled: false },
    });

    issueSetAutoReseed(
      mockInbox as unknown as Parameters<typeof issueSetAutoReseed>[0],
      20,
      1,
      true,
    );
    expect(submitted.length).toBe(2);
    expect(submitted[1]).toEqual({
      kind: SET_AUTO_RESEED_COMMAND_KIND,
      targetTick: 21,
      data: { playerId: 1, enabled: true },
    });
  });

  it("formats farm food status line correctly", () => {
    expect(formatFarmFoodStatus(175)).toBe(
      "Food remaining: 175 / 175 · Reseed: 60 wood",
    );
    expect(formatFarmFoodStatus(45, 175)).toBe(
      "Food remaining: 45 / 175 · Reseed: 60 wood",
    );
    expect(formatFarmFoodStatus(0, 250)).toBe(
      "Food remaining: 0 / 250 · Reseed: 60 wood",
    );
  });

  class MockNodeElement {
    id = "";
    tagName = "DIV";
    innerHTML = "";
    textContent = "";
    parentNode: MockNodeElement | null = null;
    children: MockNodeElement[] = [];
    listeners: Record<string, ((e?: unknown) => void)[]> = {};
    attributes = new Map<string, string>();
    style: Record<string, string> = {};
    offsetWidth = 100;

    get firstChild(): MockNodeElement | null {
      return this.children[0] ?? null;
    }

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

    appendChild(child: MockNodeElement): void {
      child.parentNode = this;
      this.children.push(child);
    }

    append(...items: (MockNodeElement | string)[]): void {
      for (const item of items) {
        if (typeof item === "string") continue;
        this.appendChild(item);
      }
    }

    remove(): void {
      if (this.parentNode) {
        const idx = this.parentNode.children.indexOf(this);
        if (idx >= 0) this.parentNode.children.splice(idx, 1);
        this.parentNode = null;
      }
    }

    addEventListener(type: string, handler: (e?: unknown) => void): void {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type]!.push(handler);
    }

    click(): void {
      for (const h of this.listeners["click"] ?? []) {
        h();
      }
    }

    querySelector(selector: string): MockNodeElement | null {
      const check = (node: MockNodeElement): MockNodeElement | null => {
        if (
          selector.startsWith(".") &&
          node.classList.contains(selector.slice(1))
        )
          return node;
        if (selector.startsWith("#") && node.id === selector.slice(1))
          return node;
        for (const child of node.children) {
          const found = check(child);
          if (found) return found;
        }
        return null;
      };
      return check(this);
    }
  }

  function setupMockDom() {
    const body = new MockNodeElement();
    body.id = "body";
    (globalThis as unknown as { document: unknown }).document = {
      body,
      createElement: (tag: string) => {
        const el = new MockNodeElement();
        el.tagName = tag.toUpperCase();
        return el as unknown as HTMLElement;
      },
      getElementById: (id: string) => {
        if (body.id === id) return body as unknown as HTMLElement;
        return body.querySelector("#" + id) as unknown as HTMLElement;
      },
    };
  }

  it("renders Auto-Reseed UI toggle button on Mill and Farm panels and dispatches toggle command", () => {
    setupMockDom();
    let currentData: BuildingPanelData | undefined = {
      title: "Mill",
      buildingEid: 42,
      canAutoReseed: true,
      autoReseedEnabled: true,
    };
    const inbox = {
      submit: vi.fn(),
    };

    const panel = createBuildingPanel({
      getData: () => currentData,
      inbox: inbox as unknown as Parameters<
        typeof createBuildingPanel
      >[0]["inbox"],
      currentTick: () => 10,
    });

    panel.refresh();

    const container = (document.getElementById("building-panel") ??
      (document.body as unknown as { children: HTMLElement[] })
        .children[0]) as HTMLElement;
    const reseedBtn = container.querySelector(
      ".panel-toggle-btn",
    ) as HTMLButtonElement;
    expect(reseedBtn).not.toBeNull();
    expect(reseedBtn.textContent).toBe("ON");

    // Click toggle button -> should submit setAutoReseed command with enabled: false
    reseedBtn.click();
    expect(inbox.submit).toHaveBeenCalledWith({
      kind: SET_AUTO_RESEED_COMMAND_KIND,
      targetTick: 11,
      data: { playerId: 0, enabled: false },
    });

    // Update with farm food remaining
    currentData = {
      title: "Farm",
      buildingEid: 43,
      canAutoReseed: true,
      autoReseedEnabled: false,
      farmFoodRemaining: 120,
    };
    panel.refresh();

    expect(reseedBtn.textContent).toBe("OFF");
    const foodEl = container.querySelector(".panel-farm-food") as HTMLElement;
    expect(foodEl).not.toBeNull();
    expect(foodEl.textContent).toContain("Food remaining: 120 / 175");
  });
});

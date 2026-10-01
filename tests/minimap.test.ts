/**
 * Tests for minimap viewport rect, resource nodes, building dots, and camera drag — V14 / Issue #100.
 */

import { describe, expect, it, vi } from "vitest";
import {
  colorForResource,
  createMinimap,
  ENEMY_BUILDING_GHOST_HEX,
  ENEMY_BUILDING_VISIBLE_HEX,
  ENEMY_DOT_HEX,
  isPointInPolygon,
  MINIMAP_RESOURCE_CLAY_HEX,
  MINIMAP_RESOURCE_COAL_HEX,
  MINIMAP_RESOURCE_FOOD_HEX,
  MINIMAP_RESOURCE_GOLD_HEX,
  MINIMAP_RESOURCE_IRON_HEX,
  MINIMAP_RESOURCE_STONE_HEX,
  MINIMAP_SHADE_BRIGHT,
  MINIMAP_SHADE_DIM,
  MINIMAP_SHADE_UNEXPLORED,
  minimapShadeFor,
  OWN_BUILDING_HEX,
  OWN_DOT_HEX,
  SELECTED_DOT_HEX,
  VIEWPORT_BORDER_STROKE,
  VIEWPORT_FILL_STYLE,
  VIEWPORT_LINE_WIDTH,
  type MinimapDeps,
} from "../src/ui/minimap";
import type { WorldLayers } from "../src/sim/world/layers";

describe("Minimap Resource Color Mapping (Issue #100)", () => {
  it("maps resource codes to distinct, high-contrast hex colors", () => {
    expect(colorForResource(0)).toBe(MINIMAP_RESOURCE_FOOD_HEX); // Food = green
    expect(colorForResource(2)).toBe(MINIMAP_RESOURCE_GOLD_HEX); // Gold = bright yellow
    expect(colorForResource(3)).toBe(MINIMAP_RESOURCE_STONE_HEX); // Stone = grey
    expect(colorForResource(4)).toBe(MINIMAP_RESOURCE_IRON_HEX); // Iron = violet
    expect(colorForResource(5)).toBe(MINIMAP_RESOURCE_COAL_HEX); // Coal = slate
    expect(colorForResource(6)).toBe(MINIMAP_RESOURCE_CLAY_HEX); // Clay = terracotta
  });

  it("returns null for wood which is baked directly into the forest terrain", () => {
    expect(colorForResource(1)).toBeNull();
    expect(colorForResource(99)).toBeNull();
  });
});

describe("Minimap Point-in-Polygon Raycasting (Issue #100)", () => {
  const quad = [
    { x: 10, y: 10 },
    { x: 30, y: 10 },
    { x: 35, y: 40 },
    { x: 5, y: 40 },
  ];

  it("identifies points inside the camera viewport polygon", () => {
    expect(isPointInPolygon(20, 25, quad)).toBe(true);
    expect(isPointInPolygon(15, 15, quad)).toBe(true);
    expect(isPointInPolygon(12, 35, quad)).toBe(true);
  });

  it("identifies points outside the camera viewport polygon", () => {
    expect(isPointInPolygon(0, 0, quad)).toBe(false);
    expect(isPointInPolygon(50, 50, quad)).toBe(false);
    expect(isPointInPolygon(20, 5, quad)).toBe(false);
    expect(isPointInPolygon(20, 45, quad)).toBe(false);
  });
});

describe("Minimap Fog Projection Stability (Issue #100)", () => {
  it("maintains the exact tri-state projection contract", () => {
    expect(minimapShadeFor(false, false)).toBe(MINIMAP_SHADE_UNEXPLORED);
    expect(minimapShadeFor(false, true)).toBe(MINIMAP_SHADE_UNEXPLORED);
    expect(minimapShadeFor(true, false)).toBe(MINIMAP_SHADE_DIM);
    expect(minimapShadeFor(true, true)).toBe(MINIMAP_SHADE_BRIGHT);
  });
});

describe("Minimap Palette & Viewport Constants (Issue #100)", () => {
  it("exports expected hex colors and stroke settings", () => {
    expect(ENEMY_BUILDING_VISIBLE_HEX).toBe("#ef4444");
    expect(ENEMY_BUILDING_GHOST_HEX).toBe("#991b1b");
    expect(OWN_BUILDING_HEX).toBe("#3b82f6");

    expect(OWN_DOT_HEX).toBe("#a9d2ff");
    expect(ENEMY_DOT_HEX).toBe("#ff8a66");
    expect(SELECTED_DOT_HEX).toBe("#ffffff");

    expect(VIEWPORT_BORDER_STROKE).toContain("254, 240, 138");
    expect(VIEWPORT_FILL_STYLE).toContain("255, 255, 255");
    expect(VIEWPORT_LINE_WIDTH).toBe(1.5);
  });
});

/** Mock Canvas Context for headless testing of drawing commands. */
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
  drawImageCalls: number = 0;

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
  arc(
    x: number,
    y: number,
    _r: number,
    _startAngle: number,
    _endAngle: number,
  ): void {
    this.path.push({ op: "arc", x, y });
  }
  save(): void {}
  restore(): void {}
  drawImage(): void {
    this.drawImageCalls++;
  }
}

class MockCanvasElement {
  id = "";
  width = 176;
  height = 176;
  style = { width: "176px", height: "176px", cursor: "crosshair" };
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  ctx = new MockCanvasContext();

  getContext(type: string): MockCanvasContext | null {
    if (type === "2d") return this.ctx;
    return null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 176, height: 176 };
  }
  setPointerCapture() {}
  addEventListener(type: string, handler: (e: unknown) => void) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type]!.push(handler);
  }
  dispatchEvent(type: string, event: unknown) {
    for (const h of this.listeners[type] ?? []) {
      h(event);
    }
  }
}

describe("Minimap Redraw & Viewport Updating in Headless DOM", () => {
  const origWindow = globalThis.window;
  const origDocument = globalThis.document;

  const mockCanvases: MockCanvasElement[] = [];

  const setupMockDom = () => {
    mockCanvases.length = 0;
    const fakeDoc = {
      createElement: (tag: string) => {
        if (tag === "canvas") {
          const c = new MockCanvasElement();
          mockCanvases.push(c);
          return c as unknown as HTMLElement;
        }
        return {} as unknown as HTMLElement;
      },
      body: {
        appendChild: () => {},
      },
    };
    (globalThis as unknown as { document: unknown }).document = fakeDoc;
    (globalThis as unknown as { window: unknown }).window = {
      innerWidth: 1920,
      innerHeight: 1080,
      devicePixelRatio: 1,
    };
  };

  const tearDownMockDom = () => {
    (globalThis as unknown as { window: unknown }).window = origWindow;
    (globalThis as unknown as { document: unknown }).document = origDocument;
  };

  it("renders resource nodes, buildings, and units on redraw", () => {
    setupMockDom();
    try {
      const size = 32;
      const fakeLayers: WorldLayers = {
        size,
        terrainType: new Uint8Array(size * size).fill(3), // grass
        elevationLevel: new Uint8Array(size * size).fill(0),
        derivedPassability: new Uint8Array(size * size).fill(1),
      };

      const setCenterMock = vi.fn();

      const deps: MinimapDeps = {
        layers: fakeLayers,
        getFrame: () =>
          ({
            count: 1,
            eids: new Int32Array([10]),
            positions: new Float32Array([10, 10]),
          }) as unknown as ReturnType<MinimapDeps["getFrame"]>,
        isSelected: (eid) => eid === 10,
        fog: {
          isExplored: (_x, _y) => true,
          isVisible: (x, _y) => x < 16,
        },
        groundPointAt: (cx, cy) => ({
          x: cx === 0 ? 5 : 25,
          y: cy === 0 ? 5 : 25,
        }),
        setCenter: setCenterMock,
        getResourceNodes: () => [
          { x: 4, y: 4, resourceCode: 2 }, // Gold (visible)
          { x: 20, y: 20, resourceCode: 3 }, // Stone (in fog)
        ],
        getBuildings: () => [
          { eid: 1, x: 2, y: 2, width: 3, height: 3, ownerId: 0 }, // Own building (visible)
          { eid: 2, x: 22, y: 22, width: 3, height: 3, ownerId: 1 }, // Enemy building (fog ghost)
        ],
        isOwnBuilding: (ownerId) => ownerId === 0,
        getCameraCenter: () => ({ x: 15, y: 15 }),
      };

      const handle = createMinimap(deps);
      expect(handle).toBeDefined();

      handle.redraw();

      // Check the main display canvas
      const mainCanvas = mockCanvases[0]!;
      expect(mainCanvas.ctx.drawImageCalls).toBeGreaterThan(0);

      // Verify updateViewport stroked the camera viewport polygon
      const strokeOps = mainCanvas.ctx.path.filter((p) => p.op === "stroke");
      expect(strokeOps.length).toBeGreaterThan(0);

      // 1. Verify pointerdown interaction outside viewport immediately jumps camera
      // clientX: 11, clientY: 11 on 176px with size 32 -> map (2, 2) which is outside quad (5..25)
      mainCanvas.dispatchEvent("pointerdown", {
        clientX: 11,
        clientY: 11,
        pointerId: 1,
        preventDefault: () => {},
      });
      expect(setCenterMock).toHaveBeenCalledWith(2, 2);

      mainCanvas.dispatchEvent("pointerup", {});

      // 2. Verify pointerdown inside viewport initiates dragging with offset
      // clientX: 88, clientY: 88 -> map (16, 16) which is inside quad (5..25)
      setCenterMock.mockClear();
      mainCanvas.dispatchEvent("pointerdown", {
        clientX: 88,
        clientY: 88,
        pointerId: 1,
        preventDefault: () => {},
      });
      // Does not jump abruptly on click inside
      expect(setCenterMock).not.toHaveBeenCalled();

      // Dragging moves the camera smoothly
      mainCanvas.dispatchEvent("pointermove", {
        clientX: 99,
        clientY: 99,
        pointerId: 1,
      });
      expect(setCenterMock).toHaveBeenCalled();

      // Verify updateViewport can be called independently
      handle.updateViewport();
      expect(mainCanvas.ctx.drawImageCalls).toBeGreaterThan(1);

      // Verify minimap alert ping registers and renders expanding arc pulses
      handle.ping(10, 10, "#f59e0b", 1000);
      handle.updateViewport();
      const arcOps = mainCanvas.ctx.path.filter((p) => p.op === "arc");
      expect(arcOps.length).toBeGreaterThan(0);
    } finally {
      tearDownMockDom();
    }
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (name: string): string => readFileSync(new URL(name, import.meta.url), "utf8");

describe("Recast browser worker artifacts", () => {
  it("uses a real module Worker and deterministic WASM readiness gate", () => {
    const adapter = source("./worker-adapter.ts");
    const worker = source("./recast.worker.ts");
    const main = source("./browser-main.ts");
    expect(adapter).toContain('new Worker(new URL("./recast.worker.ts", import.meta.url), { type: "module" })');
    expect(adapter).toContain("await adapter.ready");
    expect(main).toContain("await candidate.ready");
    expect(worker).toContain("const ready = init()");
    expect(worker).toContain('kind: "ready"');
    expect(worker).toContain("void ready.then");
  });

  it("uses actual Detour corridor and corrected supercover conversion", () => {
    const engine = source("./recast-engine.ts");
    expect(engine).toContain("findClosestPoint");
    expect(engine).toContain("findPath(");
    expect(engine).toContain("findStraightPath");
    expect(engine).toContain("Detour.DT_PARTIAL_RESULT");
    expect(engine).toContain("cs: 0.25");
    expect(engine).toContain("walkableRadius: 0");
    expect(engine).toContain("../../phase2-navigation/recast-corridor/corridor-grid");
    expect(engine).not.toContain("recast-runtime");
    expect(engine).not.toContain("createRequire");
  });

  it("drives the unchanged async production World.step harness and records worker compute", () => {
    const main = source("./browser-main.ts");
    expect(main).toContain("runBenchmarkAsync");
    expect(main).toContain('evidenceClass: "browser-worker"');
    expect(main).toContain("omitComputeMs: false");
    expect(main).toContain("recastRoutes: candidate.routes");
    const adapter = source("./worker-adapter.ts");
    expect(adapter).toContain("context.onRequest(request)");
    expect(adapter).toContain("transportContext.onResponse(message.response, message.computeMs)");
  });

  it("keeps the corrected engine body byte-identical outside browser imports", () => {
    const normalize = (text: string): string => text.slice(text.indexOf("const REVISION_CACHE_CAPACITY"));
    expect(normalize(source("./recast-engine.ts"))).toBe(normalize(readFileSync(new URL("../../phase2-navigation/recast-corridor/corridor-engine.ts", import.meta.url), "utf8")));
  });
});

/**
 * Unit-def ↔ baked-atlas wiring (issue #72 / SPEC §2.14).
 *
 * Every unit definition's activityAnims map must reference clip ids
 * that actually exist in its committed atlas frame index — a typo here
 * would surface at runtime as an invisible/never-animating unit, so it
 * fails loudly at load-test time instead.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UNIT_DEFINITIONS } from "../../src/data/definitions";
import { parseAtlasIndex } from "../../src/render/atlasFrames";

describe("unit activityAnims resolve against baked atlases", () => {
  it("every referenced clip exists in the unit's committed atlas", () => {
    expect(UNIT_DEFINITIONS.size).toBeGreaterThan(0);
    for (const [id, def] of UNIT_DEFINITIONS) {
      const anims = def.activityAnims;
      if (!anims || Object.keys(anims).length === 0) continue;
      const indexPath = new URL(
        `../../src/assets/atlas/${id}.frames.json`,
        import.meta.url,
      );
      const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
        actions: readonly { name: string }[];
      };
      const baked = new Set(index.actions.map((a) => a.name));
      for (const [activity, clip] of Object.entries(anims)) {
        expect(
          baked.has(clip),
          `${id}: activity "${activity}" → clip "${clip}" missing from atlas`,
        ).toBe(true);
      }
    }
  });

  it("every unit def carries the core locomotion trio", () => {
    for (const [id, def] of UNIT_DEFINITIONS) {
      const anims = def.activityAnims ?? {};
      for (const core of ["idle", "walk"]) {
        expect(anims[core], `${id} missing "${core}" anim`).toBeDefined();
      }
    }
  });

  it("every committed atlas frames JSON parses cleanly via parseAtlasIndex", () => {
    for (const [id] of UNIT_DEFINITIONS) {
      const indexPath = new URL(
        `../../src/assets/atlas/${id}.frames.json`,
        import.meta.url,
      );
      const raw = JSON.parse(readFileSync(indexPath, "utf8"));
      expect(() => parseAtlasIndex(raw)).not.toThrow();
    }
  });
});

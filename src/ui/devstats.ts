/**
 * Dev-only render-stats HUD — M5-T4 draw-call audit (SPEC §7).
 *
 * One fixed line showing the live renderer.info draw calls + triangle
 * count and the current sprite playback band, so the §7 budget
 * (≤150 draw calls @ 500 instances, ≤1.5 M triangles) and the LOD
 * throttle (15 fps near / 7.5 fps far past 60% zoom-out) are verifiable
 * at a glance during the documented manual pass (docs/m5-manual.md).
 *
 * The host is created ONLY under `import.meta.env.DEV` — production
 * bundles ship without it; the headless half of the audit stays in
 * tests/perf/* (attribute-write budgets). Pure formatting helpers are
 * exported for node tests.
 */

/**
 * `draws 5 · tris 12345 · anim 15 fps` — one HUD line. The playback
 * rate renders integral when whole (`15`) and one-decimal otherwise
 * (`7.5`).
 */
export function formatDrawStatsLine(
  calls: number,
  triangles: number,
  playbackFps: number,
): string {
  const rate = Number.isInteger(playbackFps)
    ? String(playbackFps)
    : playbackFps.toFixed(1);
  return `draws ${String(calls)} · tris ${String(Math.max(0, Math.round(triangles)))} · anim ${rate} fps`;
}

export interface DevStatsHandle {
  /** Repaint the line from this frame's renderer.info numbers. */
  update(calls: number, triangles: number, playbackFps: number): void;
}

export function createDevStatsHud(): DevStatsHandle {
  const el = document.createElement("div");
  el.id = "dev-stats";
  document.body.appendChild(el);
  let last = "";
  return {
    update(calls, triangles, playbackFps): void {
      const next = formatDrawStatsLine(calls, triangles, playbackFps);
      if (next === last) return;
      last = next;
      el.textContent = next;
      el.dataset.overBudget = calls > 150 ? "true" : "false";
    },
  };
}

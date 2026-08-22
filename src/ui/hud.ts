/**
 * Topbar — SPEC §2.13 M1-T8 placeholder.
 *
 * Minimal chrome: seed · tick · fps. The full resource/company topbar
 * arrives with the economy tickets; this exists so the command layer
 * has its validated at-a-glance tick/fps readout without the old
 * inline-in-main.ts hack.
 */

export interface TopbarHandle {
  update(tick: number, fpsText: string): void;
}

export function createTopbar(seed: number): TopbarHandle {
  const bar = document.createElement("div");
  bar.id = "topbar";
  const text = document.createElement("span");
  bar.appendChild(text);
  document.body.appendChild(bar);

  let lastText = "";
  return {
    update(tick: number, fpsText: string): void {
      const next = `seed ${String(seed)} · tick ${String(tick)} · ${fpsText} fps`;
      if (next !== lastText) {
        lastText = next;
        text.textContent = next;
      }
    },
  };
}

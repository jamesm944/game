/** Audio intent types — produced by UI + post-step sim event polling, consumed by the render-loop scheduler (SPEC §2.10). Sim never imports this module. */

export const AUDIO_CLIPS = [
  "ui.click",
  "ui.order",
  "ui.idle",
  "act.chop",
  "act.mine",
  "act.build",
  "combat.strike",
  "combat.death",
  "econ.meal",
  "age.up",
  "victory.win",
  "victory.defeat",
  "ambient.day",
  "ambient.night",
] as const;
export type AudioClip = (typeof AUDIO_CLIPS)[number];

export interface AudioIntent {
  clip: AudioClip;
  /** world-x for positional pan; undefined = non-positional (UI/global) */
  worldX?: number;
  /** higher survives culling first */
  priority?: number;
  /** optional playback rate / pitch override (1.0 default) */
  pitch?: number;
}

/** Clips allowed to coalesce when spammed in the same frame. */
export const COALESCABLE: ReadonlySet<AudioClip> = new Set<AudioClip>([
  "act.chop",
  "act.mine",
  "act.build",
  "combat.strike",
]);

/**
 * Coalescing math (pure, tested): given same-frame intents of one clip,
 * keep at most `maxSame` — the highest-priority ones — and return a pitch
 * multiplier spread so the survivors read as varied impacts.
 */
export function coalesceSameFrame(
  intents: readonly AudioIntent[],
  maxSame = 4,
): Array<{ intent: AudioIntent; pitch: number }> {
  if (intents.length <= maxSame) {
    return intents.map((intent, i) => ({ intent, pitch: 1 + i * 0.03 }));
  }
  const sorted = [...intents].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
  );
  const kept = sorted.slice(0, maxSame);
  return kept.map((intent, i) => ({
    intent,
    // spread detune across survivors; more spam => wider spread
    pitch:
      1 +
      ((i % maxSame) / maxSame) * 0.12 +
      Math.min(intents.length, 20) * 0.004,
  }));
}

/**
 * Placeholder clip synthesis — the audio pipeline runs end-to-end on generated
 * tones so gameplay SFX exist before CC0 asset curation lands. Every entry here
 * is a documented swap point: drop a real file into src/assets/audio/<clip>.wav
 * (sources + provenance per SPEC §6) and loadClip() prefers files over synth.
 *
 * SWAP STEPS:
 *  1. Download pack zips listed in MANIFEST.md (all verified CC0).
 *  2. Export each mapping below to src/assets/audio/<AudioClip>.wav (44.1k mono).
 *  3. Delete `synthBuffer` usage in loadClip() (keep fallback).
 *  4. Fill MANIFEST.md provenance rows.
 */

import type { AudioClip } from "./intents";

interface ClipShape {
  duration: number;
  kind: "noise" | "tone";
  freq: number;
  decay: number;
}

const SHAPES: Record<AudioClip, ClipShape> = {
  "ui.click": { duration: 0.05, kind: "tone", freq: 880, decay: 40 },
  "ui.order": { duration: 0.09, kind: "tone", freq: 620, decay: 30 },
  "ui.idle": { duration: 0.18, kind: "tone", freq: 587, decay: 16 },
  "act.chop": { duration: 0.12, kind: "noise", freq: 0, decay: 60 },
  "act.mine": { duration: 0.1, kind: "noise", freq: 0, decay: 90 },
  "act.build": { duration: 0.14, kind: "noise", freq: 0, decay: 50 },
  "combat.strike": { duration: 0.1, kind: "noise", freq: 0, decay: 70 },
  "combat.death": { duration: 0.5, kind: "tone", freq: 180, decay: 6 },
  "econ.meal": { duration: 0.15, kind: "tone", freq: 520, decay: 18 },
  "age.up": { duration: 1.2, kind: "tone", freq: 523, decay: 2 },
  "victory.win": { duration: 1.8, kind: "tone", freq: 659, decay: 1.5 },
  "victory.defeat": { duration: 1.6, kind: "tone", freq: 196, decay: 2 },
  "ambient.day": { duration: 4, kind: "noise", freq: 0, decay: 0.5 },
  "ambient.night": { duration: 4, kind: "tone", freq: 110, decay: 0.5 },
};

export function synthBuffer(ctx: AudioContext, clip: AudioClip): AudioBuffer {
  const s = SHAPES[clip];
  const len = Math.ceil(ctx.sampleRate * s.duration);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const t = i / ctx.sampleRate;
    const env = Math.exp(-s.decay * t);
    d[i] =
      s.kind === "noise"
        ? (Math.random() * 2 - 1) * env
        : Math.sin(2 * Math.PI * s.freq * t) * env;
  }
  return buf;
}

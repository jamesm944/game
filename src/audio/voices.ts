/** Voice pool: ~24 concurrent sources, distance-priority culling, same-frame coalescing, StereoPanner positional mapping (SPEC §2.10 — no PannerNode/HRTF). */

import type { Buses } from "./buses";
import { COALESCABLE, coalesceSameFrame, type AudioIntent } from "./intents";
import { synthBuffer } from "./placeholder";

const MAX_VOICES = 24;

interface CameraView {
  /** world-x at left edge of viewport */
  leftX: number;
  /** world-x at right edge of viewport */
  rightX: number;
}

export class VoicePool {
  private buffers = new Map<string, AudioBuffer>();
  private active = new Set<AudioBufferSourceNode>();
  private frameCounts = new Map<string, number>();

  constructor(
    private ctx: () => AudioContext | null,
    private buses: () => Buses | null,
    private view: () => CameraView,
  ) {}

  /** Called once per render frame BEFORE draining intents. */
  beginFrame(): void {
    this.frameCounts.clear();
    for (const node of [...this.active]) {
      if (!node.onended) this.active.delete(node);
    }
  }

  play(intents: readonly AudioIntent[]): void {
    const ctx = this.ctx();
    const buses = this.buses();
    if (!ctx || !buses) return;
    const byClip = new Map<string, AudioIntent[]>();
    for (const intent of intents) {
      if (intent.worldX !== undefined) {
        const v = this.view();
        // cull off-screen-world sounds entirely beyond a margin
        const margin = (v.rightX - v.leftX) * 0.5;
        if (
          intent.worldX < v.leftX - margin ||
          intent.worldX > v.rightX + margin
        )
          continue;
      }
      const list = byClip.get(intent.clip);
      if (list) list.push(intent);
      else byClip.set(intent.clip, [intent]);
    }
    for (const [clip, list] of byClip) {
      const playable = COALESCABLE.has(clip as never)
        ? coalesceSameFrame(list)
        : list.map((intent) => ({ intent, pitch: intent.pitch ?? 1 }));
      for (const { intent, pitch } of playable)
        this.playOne(clip as never, intent, pitch, ctx, buses);
    }
  }

  private playOne(
    clip: import("./intents").AudioClip,
    intent: AudioIntent,
    pitch: number,
    ctx: AudioContext,
    buses: Buses,
  ): void {
    if (this.active.size >= MAX_VOICES) {
      // distance-priority culling: drop the quietest active voice
      let quietest: AudioBufferSourceNode | null = null;
      let qGain = Infinity;
      for (const node of this.active) {
        const g = (node as unknown as { __gain?: number }).__gain ?? 1;
        if ((node as unknown as { __priority?: number }).__priority === -1)
          continue;
        if (g < qGain) {
          qGain = g;
          quietest = node;
        }
      }
      if (!quietest || qGain > this.gainFor(intent)) return;
      try {
        quietest.stop();
      } catch {
        /* already stopping */
      }
      this.active.delete(quietest);
    }
    const buf = this.loadClip(ctx, clip);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = pitch;

    const gain = ctx.createGain();
    const g = this.gainFor(intent);
    gain.gain.value = g;
    (src as unknown as { __gain: number; __priority: number }).__gain = g;
    (src as unknown as { __gain: number; __priority: number }).__priority =
      intent.priority ?? 0;

    let tail: AudioNode = gain;
    if (intent.worldX !== undefined) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = this.panFor(intent.worldX);
      gain.connect(pan);
      tail = pan;
    }
    const bus = clip.startsWith("ui.")
      ? buses.ui
      : clip.startsWith("ambient.")
        ? buses.ambient
        : clip.startsWith("victory.") || clip === "age.up"
          ? buses.music
          : buses.sfx;
    tail.connect(bus);

    src.onended = () => this.active.delete(src);
    src.connect(gain);
    src.start();
    this.active.add(src);
  }

  private gainFor(intent: AudioIntent): number {
    if (intent.worldX === undefined) return 1;
    const v = this.view();
    const mid = (v.leftX + v.rightX) / 2;
    const halfSpan = (v.rightX - v.leftX) / 2;
    const dist = Math.abs(intent.worldX - mid) / Math.max(halfSpan, 1e-6);
    return Math.max(0.15, 1 - dist * 0.85);
  }

  private panFor(worldX: number): number {
    const v = this.view();
    const t = (worldX - v.leftX) / Math.max(v.rightX - v.leftX, 1e-6);
    return Math.min(1, Math.max(-1, t * 2 - 1));
  }

  public async preload(ctx: AudioContext): Promise<void> {
    const clips: import("./intents").AudioClip[] = [
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
    ];
    await Promise.all(clips.map((clip) => this.loadClipAsync(ctx, clip)));
  }

  private async loadClipAsync(
    ctx: AudioContext,
    clip: import("./intents").AudioClip,
  ): Promise<void> {
    try {
      const url = new URL(`../assets/audio/${clip}.wav`, import.meta.url).href;
      const resp = await fetch(url);
      if (resp.ok) {
        const arr = await resp.arrayBuffer();
        const decoded = await ctx.decodeAudioData(arr);
        this.buffers.set(clip, decoded);
      }
    } catch {
      // retain synth fallback
    }
  }

  private loadClip(
    ctx: AudioContext,
    clip: import("./intents").AudioClip,
  ): AudioBuffer {
    let buf = this.buffers.get(clip);
    if (!buf) {
      buf = synthBuffer(ctx, clip);
      this.buffers.set(clip, buf);
      if (typeof window !== "undefined" && typeof fetch !== "undefined") {
        void this.loadClipAsync(ctx, clip);
      }
    }
    return buf;
  }

  get activeCount(): number {
    return this.active.size;
  }
}

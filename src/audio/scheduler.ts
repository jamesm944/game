/** Render-loop scheduler: drains an intent queue each frame (SPEC §2.10). Sim events reach it via simBridge — this module never imports sim. */

import type { AudioIntent } from "./intents";

export class AudioScheduler {
  private queue: AudioIntent[] = [];
  private ambientClip: "ambient.day" | "ambient.night" | null = null;
  private lastAmbientSwitchMs = -Infinity;

  push(intent: AudioIntent): void {
    this.queue.push(intent);
  }

  click(): void {
    this.push({ clip: "ui.click" });
  }
  order(): void {
    this.push({ clip: "ui.order" });
  }

  /** Non-positional stingers fired by game flow (age/victory overlays). */
  stinger(name: "age.up" | "victory.win" | "victory.defeat"): void {
    this.push({ clip: name, priority: 10 });
  }

  /** Ambient loop selection by clock minute; re-trigger throttled. */
  ambient(minuteOfDay: number, nowMs: number): void {
    const want: "ambient.day" | "ambient.night" =
      minuteOfDay >= 300 && minuteOfDay < 1320
        ? "ambient.day"
        : "ambient.night";
    if (want !== this.ambientClip && nowMs - this.lastAmbientSwitchMs > 8000) {
      this.ambientClip = want;
      this.lastAmbientSwitchMs = nowMs;
      this.push({ clip: want, priority: 2 });
    }
  }

  drain(
    play: (intents: readonly AudioIntent[]) => void,
  ): readonly AudioIntent[] {
    const batch = this.queue;
    this.queue = [];
    play(batch);
    return batch;
  }
}

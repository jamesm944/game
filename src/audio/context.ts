/** Gesture-gated AudioContext bootstrap (SPEC §2.10): browsers block audio until a user gesture; we create/resume on first pointer/key event. */

let ctx: AudioContext | null = null;
let hooked = false;

export function ensureAudio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx) {
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  }
  const Ctor = window.AudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  return ctx;
}

export function hookGestureGate(): void {
  if (hooked || typeof window === "undefined") return;
  hooked = true;
  const wake = () => {
    ensureAudio();
    window.removeEventListener("pointerdown", wake);
    window.removeEventListener("keydown", wake);
  };
  window.addEventListener("pointerdown", wake);
  window.addEventListener("keydown", wake);
}

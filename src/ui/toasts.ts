/**
 * In-game notification toast and alert system — V14 / Issue #104.
 *
 * Provides:
 * 1. Stacking centre-left toast container with glassmorphism styling.
 * 2. Under-attack alert with throttle deduplication and click-to-camera-jump.
 * 3. Research completion alert.
 * 4. Age-up alert.
 * 5. Idle unit alert.
 * 6. Pure DOM/CSS implementation with zero simulation tick overhead and ARIA accessibility.
 */

export type ToastKind =
  | "under-attack"
  | "research-complete"
  | "age-up"
  | "unit-idle"
  | "generic";

export interface ToastOptions {
  readonly id?: string;
  readonly kind: ToastKind;
  readonly message: string;
  readonly subtitle?: string;
  readonly location?: { readonly x: number; readonly y: number };
  readonly durationMs?: number;
  readonly iconSvg?: string;
}

export interface ToastManagerOptions {
  readonly container?: HTMLElement;
  readonly onJumpTo?: (x: number, y: number) => void;
  readonly attackThrottleMs?: number;
  readonly idleThrottleMs?: number;
}

export interface ToastManager {
  readonly container: HTMLElement;
  show(options: ToastOptions): string;
  dismiss(toastId: string): void;
  clear(): void;
  notifyUnderAttack(x: number, y: number, label?: string): boolean;
  notifyResearchComplete(techName: string): void;
  notifyAgeUp(ageName: string): void;
  notifyUnitIdle(x: number, y: number, unitName?: string): boolean;
  destroy(): void;
}

const DEFAULT_DURATION_MS = 4000;
const DEFAULT_ATTACK_THROTTLE_MS = 4000;
const DEFAULT_IDLE_THROTTLE_MS = 8000;

export function formatUnderAttackMessage(label?: string): {
  message: string;
  subtitle: string;
} {
  return {
    message: "⚔ Under attack!",
    subtitle: label ?? "Units or buildings taking damage",
  };
}

export function formatResearchCompleteMessage(techName: string): string {
  return `✓ ${techName} researched`;
}

export function formatAgeUpMessage(ageName: string): string {
  return `⚜ ${ageName} reached!`;
}

export function formatUnitIdleMessage(unitName?: string): {
  message: string;
  subtitle: string;
} {
  return {
    message: "💤 Military unit idle",
    subtitle: unitName ?? "Standing ground with no orders",
  };
}

export function getIconForKind(kind: ToastKind): string {
  switch (kind) {
    case "under-attack":
      return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="14.5 17.5 3 6 6 3 17.5 14.5"/>
        <line x1="13" y1="19" x2="19" y2="13"/>
        <line x1="16" y1="16" x2="20" y2="20"/>
        <line x1="19" y1="21" x2="21" y2="19"/>
        <polyline points="9.5 6.5 21 18 18 21 6.5 9.5"/>
        <line x1="11" y1="5" x2="5" y2="11"/>
        <line x1="8" y1="8" x2="4" y2="4"/>
        <line x1="5" y1="3" x2="3" y2="5"/>
      </svg>`;
    case "research-complete":
      return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10 2v7.31a2 2 0 0 1-.3.98L4.3 19A2 2 0 0 0 6 22h12a2 2 0 0 0 1.7-3l-5.4-8.71a2 2 0 0 1-.3-.99V2"/>
        <path d="M8.5 2h7M14 9.3V14M7.5 16h9"/>
      </svg>`;
    case "age-up":
      return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/>
      </svg>`;
    case "unit-idle":
      return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 12h8l-8 8h8M14 4h6l-6 6h6"/>
      </svg>`;
    case "generic":
    default:
      return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>`;
  }
}

export function createToastManager(
  options: ToastManagerOptions = {},
): ToastManager {
  const container =
    options.container ??
    (() => {
      const el = document.createElement("div");
      el.id = "game-toast-container";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      document.body.appendChild(el);
      return el;
    })();

  const attackThrottleMs =
    options.attackThrottleMs ?? DEFAULT_ATTACK_THROTTLE_MS;
  const idleThrottleMs = options.idleThrottleMs ?? DEFAULT_IDLE_THROTTLE_MS;

  let lastAttackTime = 0;
  let lastIdleTime = 0;
  let nextToastId = 1;

  interface ActiveToast {
    readonly element: HTMLElement;
    readonly timerId: ReturnType<typeof setTimeout>;
  }

  const activeToasts = new Map<string, ActiveToast>();

  function dismiss(toastId: string): void {
    const active = activeToasts.get(toastId);
    if (!active) return;
    clearTimeout(active.timerId);
    activeToasts.delete(toastId);

    active.element.classList.add("dismissing");
    active.element.addEventListener(
      "animationend",
      () => {
        if (active.element.parentNode === container) {
          container.removeChild(active.element);
        }
      },
      { once: true },
    );
    // Fallback removal if animationend doesn't fire
    setTimeout(() => {
      if (active.element.parentNode === container) {
        container.removeChild(active.element);
      }
    }, 400);
  }

  function show(toastOpts: ToastOptions): string {
    const id = toastOpts.id ?? `toast-${String(nextToastId++)}`;
    const durationMs = toastOpts.durationMs ?? DEFAULT_DURATION_MS;

    // If toast with this id already exists, dismiss it first
    if (activeToasts.has(id)) {
      dismiss(id);
    }

    const toastEl = document.createElement("div");
    toastEl.className = `game-toast game-toast-${toastOpts.kind}`;
    toastEl.setAttribute("data-toast-id", id);
    if (toastOpts.location) {
      toastEl.classList.add("game-toast-clickable");
      toastEl.setAttribute("title", "Click to jump to location");
    }

    const iconSvg = toastOpts.iconSvg ?? getIconForKind(toastOpts.kind);

    toastEl.innerHTML = `
      <div class="game-toast-icon">${iconSvg}</div>
      <div class="game-toast-content">
        <div class="game-toast-title">${toastOpts.message}</div>
        ${toastOpts.subtitle ? `<div class="game-toast-subtitle">${toastOpts.subtitle}</div>` : ""}
      </div>
      ${
        toastOpts.location
          ? `<div class="game-toast-jump-hint">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>
              </svg>
            </div>`
          : ""
      }
    `;

    if (toastOpts.location && options.onJumpTo) {
      const loc = toastOpts.location;
      toastEl.addEventListener("click", () => {
        options.onJumpTo?.(loc.x, loc.y);
        dismiss(id);
      });
    }

    // Auto-dismiss timer
    const timerId = setTimeout(() => {
      dismiss(id);
    }, durationMs);

    activeToasts.set(id, { element: toastEl, timerId });
    container.appendChild(toastEl);

    // Limit visible toasts to 4
    while (activeToasts.size > 4) {
      const oldestId = activeToasts.keys().next().value;
      if (oldestId) {
        dismiss(oldestId);
      } else {
        break;
      }
    }

    return id;
  }

  function notifyUnderAttack(
    x: number,
    y: number,
    label?: string,
  ): boolean {
    const now = Date.now();
    if (now - lastAttackTime < attackThrottleMs) {
      return false;
    }
    lastAttackTime = now;
    show({
      kind: "under-attack",
      message: "⚔ Under attack!",
      subtitle: label ?? "Units or buildings taking damage",
      location: { x, y },
      durationMs: DEFAULT_DURATION_MS,
    });
    return true;
  }

  function notifyResearchComplete(techName: string): void {
    show({
      kind: "research-complete",
      message: `✓ ${techName} researched`,
      durationMs: DEFAULT_DURATION_MS,
    });
  }

  function notifyAgeUp(ageName: string): void {
    show({
      kind: "age-up",
      message: `⚜ ${ageName} reached!`,
      durationMs: 5000,
    });
  }

  function notifyUnitIdle(
    x: number,
    y: number,
    unitName?: string,
  ): boolean {
    const now = Date.now();
    if (now - lastIdleTime < idleThrottleMs) {
      return false;
    }
    lastIdleTime = now;
    show({
      kind: "unit-idle",
      message: "💤 Military unit idle",
      subtitle: unitName ?? "Standing ground with no orders",
      location: { x, y },
      durationMs: DEFAULT_DURATION_MS,
    });
    return true;
  }

  function clear(): void {
    for (const id of Array.from(activeToasts.keys())) {
      dismiss(id);
    }
  }

  function destroy(): void {
    clear();
    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }
  }

  return {
    container,
    show,
    dismiss,
    clear,
    notifyUnderAttack,
    notifyResearchComplete,
    notifyAgeUp,
    notifyUnitIdle,
    destroy,
  };
}

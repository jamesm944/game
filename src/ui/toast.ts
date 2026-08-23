/**
 * Polite rejection toasts — SPEC §2.13 (order feedback within the same
 * frame, M2-T4 age-gate refusals).
 *
 * A single transient element re-used across messages: calling show()
 * for a fresh reason repaints immediately, repeat calls with the SAME
 * message just extend the visible window (no DOM churn). Pure DOM
 * chrome — the sim seam stays untouched; callers pass verdicts the
 * handlers already computed.
 */

const TOAST_VISIBLE_MS = 3200;

export interface ToastHandle {
  show(message: string): void;
}

export function createToastHost(): ToastHandle {
  let el: HTMLDivElement | undefined;
  let hideTimer: number | undefined;
  let lastMessage = "";

  function ensureElement(): HTMLDivElement {
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      document.body.appendChild(el);
    }
    return el;
  }

  return {
    show(message: string): void {
      const node = ensureElement();
      if (message !== lastMessage) {
        // Restart the fade-in so a changed reason visibly re-lands.
        node.classList.remove("visible");
        void node.offsetWidth; // flush styles before re-adding
      }
      lastMessage = message;
      node.textContent = message;
      node.classList.add("visible");
      if (hideTimer !== undefined) window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        node.classList.remove("visible");
        hideTimer = undefined;
      }, TOAST_VISIBLE_MS);
    },
  };
}

/**
 * Age-Up Cinematic Banner & Screen Flash — V13 (#98).
 *
 * Provides:
 * 1. Screen flash: 0.3s white flash overlay fading out.
 * 2. Mid-screen toast notification: "[Age Name] reached!" with authentic age icon.
 * 3. Pure formatting helpers for headless testing.
 */

export const AGE_TITLES: Record<number, { numeral: string; name: string }> = {
  1: { numeral: "I", name: "DARK AGE" },
  2: { numeral: "II", name: "FEUDAL AGE" },
  3: { numeral: "III", name: "CASTLE AGE" },
  4: { numeral: "IV", name: "IMPERIAL AGE" },
};

/** Format canonical age toast string, e.g. "Feudal Age reached!" */
export function formatAgeToast(ageRank: number): string {
  const titles: Record<number, string> = {
    1: "Dark Age",
    2: "Feudal Age",
    3: "Castle Age",
    4: "Imperial Age",
  };
  const name = titles[ageRank] ?? `Age ${ageRank}`;
  return `${name} reached!`;
}

export function formatAgeUpTitle(ageRank: number): string {
  const info = AGE_TITLES[ageRank] ?? {
    numeral: String(ageRank),
    name: `AGE ${ageRank}`,
  };
  return `${info.numeral} · ${info.name}`;
}

/** SVG emblem / shield for each age rank */
export function ageIconSvg(ageRank: number): string {
  switch (ageRank) {
    case 1:
      // Dark Age: Camp / Iron hearth shield
      return `<svg viewBox="0 0 48 48" width="48" height="48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M24 4L8 10V22C8 32 15 40 24 44C33 40 40 32 40 22V10L24 4Z" fill="#1e293b" stroke="#94a3b8" stroke-width="2"/>
        <path d="M24 14V34M18 20L24 14L30 20" stroke="#cbd5e1" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
    case 2:
      // Feudal Age: Bronze Archery / Spear shield
      return `<svg viewBox="0 0 48 48" width="48" height="48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M24 4L8 10V22C8 32 15 40 24 44C33 40 40 32 40 22V10L24 4Z" fill="#382414" stroke="#cd7f32" stroke-width="2"/>
        <path d="M19 16V32M29 16V32M14 24H34" stroke="#e0a96d" stroke-width="2.5" stroke-linecap="round"/>
      </svg>`;
    case 3:
      // Castle Age: Crimson Castle Tower / Silver Rampart
      return `<svg viewBox="0 0 48 48" width="48" height="48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M24 4L8 10V22C8 32 15 40 24 44C33 40 40 32 40 22V10L24 4Z" fill="#4a151b" stroke="#e74c3c" stroke-width="2"/>
        <path d="M16 16H32V32H16V16ZM18 16V13H21V16H27V13H30V16" stroke="#f5b7b1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
    case 4:
    default:
      // Imperial Age: Royal Gold Crown / Laurels
      return `<svg viewBox="0 0 48 48" width="48" height="48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M24 4L8 10V22C8 32 15 40 24 44C33 40 40 32 40 22V10L24 4Z" fill="#3a2a06" stroke="#ffd700" stroke-width="2"/>
        <path d="M14 30L17 18L24 24L31 18L34 30H14Z" fill="#f1c40f" stroke="#ffeaa7" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>`;
  }
}

/** Trigger screen flash overlay (0.3s fade-out) */
export function triggerScreenFlash(parent?: HTMLElement): void {
  if (typeof document === "undefined") return;
  const root = parent ?? document.body;
  let flashEl = document.getElementById("screen-flash");
  if (!flashEl) {
    flashEl = document.createElement("div");
    flashEl.id = "screen-flash";
    root.appendChild(flashEl);
  }
  flashEl.classList.remove("flash-active");
  void flashEl.offsetWidth; // trigger reflow
  flashEl.classList.add("flash-active");
}

export interface AgeUpBanner {
  show(ageRank: number): void;
  dispose(): void;
}

export function createAgeUpBanner(parent?: HTMLElement): AgeUpBanner {
  if (typeof document === "undefined") {
    return {
      show(): void {},
      dispose(): void {},
    };
  }
  const root = parent ?? document.body;

  // Screen flash element
  let flashEl = document.getElementById("screen-flash");
  if (!flashEl) {
    flashEl = document.createElement("div");
    flashEl.id = "screen-flash";
    root.appendChild(flashEl);
  }

  // Mid-screen toast container
  let container = document.getElementById("age-up-banner");
  if (!container) {
    container = document.createElement("div");
    container.id = "age-up-banner";
    root.appendChild(container);
  }

  container.innerHTML = `
    <div class="age-up-card">
      <div id="age-up-icon" class="age-up-icon-wrap"></div>
      <div class="age-up-header">⚔️ AGE ADVANCEMENT ⚔️</div>
      <div id="age-up-title" class="age-up-title">FEUDAL AGE REACHED!</div>
      <div id="age-up-subtitle" class="age-up-subtitle">Advanced to the next era</div>
    </div>
  `;

  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    show(ageRank: number): void {
      triggerScreenFlash(root);

      const info = AGE_TITLES[ageRank] ?? {
        numeral: String(ageRank),
        name: `AGE ${ageRank}`,
      };
      const titleEl = container?.querySelector("#age-up-title");
      const subEl = container?.querySelector("#age-up-subtitle");
      const iconEl = container?.querySelector("#age-up-icon");

      if (titleEl) titleEl.textContent = formatAgeToast(ageRank);
      if (subEl)
        subEl.textContent = `Welcome to the ${info.name.toLowerCase()}!`;
      if (iconEl) iconEl.innerHTML = ageIconSvg(ageRank);

      if (hideTimer) clearTimeout(hideTimer);

      container?.classList.remove("banner-visible");
      void container?.offsetWidth;
      container?.classList.add("banner-visible");

      // Slide out after 3.2 seconds
      hideTimer = setTimeout(() => {
        container?.classList.remove("banner-visible");
      }, 3200);
    },

    dispose(): void {
      if (hideTimer) clearTimeout(hideTimer);
      container?.remove();
      flashEl?.remove();
    },
  };
}

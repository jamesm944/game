/**
 * Age-Up Cinematic Banner — V11 (#82).
 *
 * Displays an authentic AoE2-style banner sliding in from the top with
 * golden filigree, Roman numeral crest, and royal fanfare when advancing age.
 */

export const AGE_TITLES: Record<number, { numeral: string; name: string }> = {
  1: { numeral: "I", name: "DARK AGE" },
  2: { numeral: "II", name: "FEUDAL AGE" },
  3: { numeral: "III", name: "CASTLE AGE" },
  4: { numeral: "IV", name: "IMPERIAL AGE" },
};

export function formatAgeUpTitle(ageRank: number): string {
  const info = AGE_TITLES[ageRank] ?? {
    numeral: String(ageRank),
    name: `AGE ${ageRank}`,
  };
  return `${info.numeral} · ${info.name}`;
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
  const container = document.createElement("div");
  container.id = "age-up-banner";
  container.style.position = "fixed";
  container.style.top = "48px";
  container.style.left = "50%";
  container.style.transform = "translateX(-50%) translateY(-150%) scale(0.95)";
  container.style.zIndex = "1000";
  container.style.pointerEvents = "none";
  container.style.opacity = "0";
  container.style.transition =
    "transform 0.45s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.45s ease";

  container.innerHTML = `
    <div style="
      background: linear-gradient(180deg, rgba(20, 24, 33, 0.96) 0%, rgba(10, 12, 18, 0.98) 100%);
      border: 2px solid #d4af37;
      border-radius: 8px;
      padding: 16px 48px;
      text-align: center;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.75), 0 0 28px rgba(212, 175, 55, 0.35);
      min-width: 320px;
    ">
      <div style="
        font-family: 'Cinzel', serif, Georgia;
        font-size: 11px;
        letter-spacing: 4px;
        color: #f1c40f;
        text-transform: uppercase;
        margin-bottom: 4px;
      ">⚔️ AGE ADVANCEMENT ⚔️</div>
      <div id="age-up-title" style="
        font-family: 'Cinzel', serif, Georgia;
        font-size: 24px;
        font-weight: bold;
        letter-spacing: 3px;
        color: #ffffff;
        text-shadow: 0 0 12px rgba(212, 175, 55, 0.6);
        margin: 4px 0;
      ">FEUDAL AGE</div>
      <div id="age-up-subtitle" style="
        font-family: monospace, sans-serif;
        font-size: 12px;
        color: #bdc3c7;
        letter-spacing: 1px;
      ">Advanced to the next era</div>
    </div>
  `;

  root.appendChild(container);

  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    show(ageRank: number): void {
      const info = AGE_TITLES[ageRank] ?? {
        numeral: String(ageRank),
        name: `AGE ${ageRank}`,
      };
      const titleEl = container.querySelector("#age-up-title");
      const subEl = container.querySelector("#age-up-subtitle");
      if (titleEl) titleEl.textContent = `${info.numeral} · ${info.name}`;
      if (subEl)
        subEl.textContent = `You have advanced to the ${info.name.toLowerCase()}!`;

      if (hideTimer) clearTimeout(hideTimer);

      // Slide in
      container.style.opacity = "1";
      container.style.transform = "translateX(-50%) translateY(0) scale(1)";

      // Slide out after 3.8 seconds
      hideTimer = setTimeout(() => {
        container.style.opacity = "0";
        container.style.transform =
          "translateX(-50%) translateY(-150%) scale(0.95)";
      }, 3800);
    },

    dispose(): void {
      if (hideTimer) clearTimeout(hideTimer);
      container.remove();
    },
  };
}

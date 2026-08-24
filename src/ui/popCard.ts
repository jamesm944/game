/**
 * Pop card — SPEC §2.13 prototype-validated panel / M3-T9 (issue #54).
 *
 * Selecting exactly ONE named Pop shows their card: name · age · origin
 * · life stage, trait chips, top skill bars with the knowledge-vs-
 * practice visual split (the theory segment is the lighter left band),
 * the six-part body injury strip, hp for combatants, the morale meter
 * against its break point with a ROUTING badge while fleeing, and the
 * current-activity line.
 *
 * Data flows in from a polling callback — `sim/popCard.buildPopCard`
 * output, the exact rows golden digests hash — and the DOM host follows
 * the buildingPanel pattern: structural rebuilds keyed off the data,
 * volatile lines repainted by text comparison. Pure formatting helpers
 * are exported for headless tests; like every chrome module the DOM
 * host itself stays browser-only.
 */

import type { PopCardData } from "../sim/popCard";

/** "Alric · 24.3 days · adult · born here". */
export function formatPopCardTitle(data: PopCardData): string {
  return `${data.name} · ${data.ageDays.toFixed(1)} days · ${data.lifestage} · ${data.originLabel}`;
}

/**
 * One skill bar's label: slug, derived level, and the theory share as a
 * percentage — e.g. "gathering 4 (75% knowledge)".
 */
export function formatSkillBarLabel(
  skill: PopCardData["skills"][number],
): string {
  const pct = Math.round(skill.knowledgeShare01 * 100);
  return `${skill.slug} ${String(skill.level)} (${String(pct)}% knowledge)`;
}

/**
 * The morale line: value against the derived break point, plus the
 * routing badge text when broken — e.g. "morale 62/100 · breaks ≤ 18"
 * or "morale 5/100 · breaks ≤ 12 · ROUTING".
 */
export function formatMoraleLine(data: PopCardData): string {
  if (!data.morale) return "";
  const base = `morale ${String(data.morale.value)}/100`;
  if (data.morale.breakPoint === undefined && !data.morale.routing) {
    return base;
  }
  const parts = [base];
  if (data.morale.breakPoint !== undefined) {
    parts.push(`breaks ≤ ${String(data.morale.breakPoint)}`);
  }
  if (data.morale.routing) parts.push("ROUTING");
  return parts.join(" · ");
}

/** The body strip: one status token per part in canonical order. */
export function formatBodyStrip(data: PopCardData): string {
  return data.bodyParts
    .map((part) =>
      part.status === "healthy"
        ? part.part
        : `${part.part}:${part.status}${part.severity > 0 ? ` ${String(part.severity)}` : ""}`,
    )
    .join(" · ");
}

export function createPopCard(deps: { getData(): PopCardData | undefined }): {
  refresh(): void;
} {
  const card = document.createElement("div");
  card.id = "pop-card";
  card.style.display = "none";
  document.body.appendChild(card);

  const titleEl = document.createElement("h3");
  titleEl.className = "pop-card-title";
  const traitsEl = document.createElement("div");
  traitsEl.className = "pop-card-traits";
  const skillsEl = document.createElement("div");
  skillsEl.className = "pop-card-skills";
  const bodyEl = document.createElement("div");
  bodyEl.className = "pop-card-body";
  const moraleBarWrap = document.createElement("div");
  moraleBarWrap.className = "panel-bar pop-card-morale-bar";
  const moraleFill = document.createElement("div");
  moraleFill.className = "panel-bar-fill pop-card-morale-fill";
  moraleBarWrap.appendChild(moraleFill);
  const moraleEl = document.createElement("div");
  moraleEl.className = "pop-card-morale-line";
  const activityEl = document.createElement("div");
  activityEl.className = "pop-card-activity";

  let lastKey = "";

  return {
    refresh(): void {
      const data = deps.getData();
      if (!data) {
        if (lastKey !== "") {
          lastKey = "";
          card.style.display = "none";
        }
        return;
      }
      // The activity line is volatile; everything else keys rebuilds.
      const { activity, ...structural } = data;
      void activity;
      const key = JSON.stringify(structural);
      const structuralChange = key !== lastKey;
      if (structuralChange) {
        lastKey = key;
        card.style.display = "block";
        while (card.firstChild) card.firstChild.remove();
        titleEl.textContent = formatPopCardTitle(data);
        traitsEl.replaceChildren(
          ...data.traits.map((trait) => {
            const chip = document.createElement("span");
            chip.className = "pop-card-trait-chip";
            chip.textContent = trait;
            return chip;
          }),
        );
        if (data.traits.length === 0) traitsEl.textContent = "—";
        skillsEl.replaceChildren(
          ...data.skills.map((skill) => {
            const row = document.createElement("div");
            row.className = "pop-card-skill";
            const bar = document.createElement("div");
            bar.className = "pop-card-skill-bar";
            const practice = document.createElement("div");
            practice.className = "pop-card-skill-practice";
            practice.style.width = "100%";
            const knowledge = document.createElement("div");
            knowledge.className = "pop-card-skill-knowledge";
            knowledge.style.width = `${Math.round(skill.knowledgeShare01 * 100)}%`;
            bar.append(practice, knowledge);
            const label = document.createElement("span");
            label.textContent = formatSkillBarLabel(skill);
            row.append(bar, label);
            return row;
          }),
        );
        if (data.skills.length === 0) skillsEl.textContent = "no training";
        bodyEl.textContent = formatBodyStrip(data);
        if (data.hp) {
          const hpLine = document.createElement("div");
          hpLine.className = "pop-card-hp";
          hpLine.textContent = `hp ${String(data.hp.current)}/${String(data.hp.max)}`;
          bodyEl.appendChild(hpLine);
        }
        moraleFill.style.width = `${String(data.morale ? Math.round(Math.min(1, Math.max(0, data.morale.value / 100)) * 100) : 0)}%`;
        card.append(
          titleEl,
          traitsEl,
          skillsEl,
          bodyEl,
          moraleBarWrap,
          moraleEl,
          activityEl,
        );
      }
      // Volatile repaints (every frame, text-compared).
      const moraleText = formatMoraleLine(data);
      if (moraleEl.textContent !== moraleText) {
        moraleEl.textContent = moraleText;
        moraleEl.classList.toggle(
          "pop-card-routing",
          data.morale?.routing === true,
        );
      }
      if (activityEl.textContent !== data.activity) {
        activityEl.textContent = data.activity;
      }
    },
  };
}

/**
 * Company oversight panel — SPEC §2.7 / M4-T2+T3 (issues #57, #58).
 *
 * One block per chartered company: treasury balance, branch output
 * share (live-editable), freeze toggle, expansion approval mode
 * (always-ask / auto-approve), branch list with serving foremen and a
 * per-branch SEIZE action, the ledger tail exactly as the TreasuryDelta
 * rows hold it, the public EXPANSION LOG (executions, verdicts,
 * seizures, organic foundings), any always-ask proposal awaiting a
 * verdict, and a DISSOLVE action that reverts every branch. Plus a
 * charter form whenever the player's selection contains charter-able
 * finished workplaces — chartering absorbs the whole selection as seed
 * branches.
 *
 * Data flows in from a polling callback each refresh (the same rows
 * golden digests hash); blocks only rebuild when the structural key
 * changes, so interacting never fights a re-render mid-gesture.
 */

import type { CommandInbox } from "../sim/core/inbox";

/** One branch line inside a company block. */
export interface CompanyPanelBranch {
  readonly buildingEid: number;
  /** e.g. "Kitchen #12". */
  readonly label: string;
  /** "Foreman Alric" or undefined while the seat is open. */
  readonly foremanLabel?: string | undefined;
}

/** One ledger-tail entry (TreasuryDelta row decode). */
export interface CompanyPanelLedgerEntry {
  readonly tick: number;
  /** Formatted credit amount, e.g. "+2.00". */
  readonly credits: string;
}

/** One public-history entry (ExpansionLog row decode). */
export interface CompanyPanelLogEntry {
  readonly tick: number;
  /** Human-readable act, e.g. "expanded to (12, 8)". */
  readonly text: string;
}

/** An always-ask proposal awaiting the player's verdict. */
export interface CompanyPanelPending {
  /** e.g. "Mining Camp". */
  readonly defLabel: string;
  readonly tileX: number;
  readonly tileY: number;
}

/** Organic-origin status for the dissolve affordance. */
export interface CompanyPanelOrganic {
  /** True while dissolveCompany is free of charge. */
  readonly withinGraceWindow: boolean;
}

/** One chartered-company block. */
export interface CompanyPanelEntry {
  readonly companyId: number;
  readonly name: string;
  /** e.g. "food". */
  readonly focusSlug: string;
  /** Formatted treasury balance, e.g. "12.00 cr". */
  readonly treasuryLabel: string;
  readonly sharePct: number;
  readonly frozen: boolean;
  /** true = auto-approve expansions; false = always ask. */
  readonly approvalAuto: boolean;
  readonly branches: readonly CompanyPanelBranch[];
  /** Ledger tail, newest first. */
  readonly ledgerTail: readonly CompanyPanelLedgerEntry[];
  /** Public expansion history, newest first. */
  readonly logTail: readonly CompanyPanelLogEntry[];
  readonly pending?: CompanyPanelPending | undefined;
  readonly organic?: CompanyPanelOrganic | undefined;
}

/** Charter-form offer when the selection holds seed-able workplaces. */
export interface CompanyPanelCharterOffer {
  readonly focusSlugs: readonly string[];
  readonly seedLabels: readonly string[];
}

export interface CompanyPanelData {
  readonly companies: readonly CompanyPanelEntry[];
  readonly charterOffer?: CompanyPanelCharterOffer | undefined;
}

export interface CharterPayload {
  readonly name: string;
  readonly focusDomain: number;
  readonly seedBuildingIds: readonly number[];
}

export function createCompanyPanel(deps: {
  getData(): CompanyPanelData | undefined;
  currentTick(): number;
  inbox: CommandInbox;
  selectedSeedBuildingIds(): readonly number[];
  issueCharter(payload: CharterPayload): void;
  issueShare(payload: { companyId: number; sharePct: number }): void;
  issueFrozen(payload: { companyId: number; frozen: boolean }): void;
  issueApprovalMode(payload: { companyId: number; auto: boolean }): void;
  issueVerdict(payload: { companyId: number; approve: boolean }): void;
  issueSeize(payload: { companyId: number; branchId: number }): void;
  issueDissolve(payload: { companyId: number }): void;
}): { refresh(): void } {
  const panel = document.createElement("div");
  panel.id = "company-panel";
  panel.style.display = "none";
  document.body.appendChild(panel);

  const titleEl = document.createElement("h3");
  titleEl.textContent = "Companies";
  const bodyEl = document.createElement("div");
  bodyEl.className = "company-panel-body";

  let lastKey = "";

  const buildCompanyBlock = (entry: CompanyPanelEntry): HTMLElement => {
    const block = document.createElement("div");
    block.className = "company-block";

    const heading = document.createElement("div");
    heading.className = "company-heading";
    heading.textContent = entry.name;
    block.appendChild(heading);

    const stats = document.createElement("div");
    stats.className = "company-stats";
    stats.textContent = `focus ${entry.focusSlug} · treasury ${entry.treasuryLabel}`;
    block.appendChild(stats);

    const controls = document.createElement("div");
    controls.className = "company-controls";
    const shareInput = document.createElement("input");
    shareInput.type = "number";
    shareInput.min = "0";
    shareInput.max = "100";
    shareInput.step = "5";
    shareInput.value = String(entry.sharePct);
    shareInput.title = "Branch output share (%)";
    shareInput.addEventListener("change", () => {
      deps.issueShare({
        companyId: entry.companyId,
        sharePct: Number(shareInput.value),
      });
    });
    const shareLabel = document.createElement("span");
    shareLabel.textContent = "share %";
    const freezeButton = document.createElement("button");
    freezeButton.className = "company-freeze";
    freezeButton.textContent = entry.frozen ? "Unfreeze" : "Freeze";
    freezeButton.addEventListener("click", () => {
      deps.issueFrozen({ companyId: entry.companyId, frozen: !entry.frozen });
    });
    const approvalButton = document.createElement("button");
    approvalButton.className = "company-approval";
    approvalButton.title = "Expansion approval mode (SPEC §2.7)";
    approvalButton.textContent = entry.approvalAuto
      ? "Approval: auto"
      : "Approval: ask";
    approvalButton.addEventListener("click", () => {
      deps.issueApprovalMode({
        companyId: entry.companyId,
        auto: !entry.approvalAuto,
      });
    });
    const dissolveButton = document.createElement("button");
    dissolveButton.className = "company-dissolve";
    dissolveButton.textContent = "Dissolve";
    dissolveButton.title =
      entry.organic !== undefined && !entry.organic.withinGraceWindow
        ? "Dissolving past the grace window costs gold severance"
        : "Revert every branch; Pops return to the labor pool";
    dissolveButton.addEventListener("click", () => {
      deps.issueDissolve({ companyId: entry.companyId });
    });
    controls.append(
      shareLabel,
      shareInput,
      freezeButton,
      approvalButton,
      dissolveButton,
    );
    if (entry.frozen) {
      const frozenNote = document.createElement("div");
      frozenNote.className = "company-frozen-note";
      frozenNote.textContent = "FROZEN — staffing/expansion halted";
      block.appendChild(frozenNote);
    }
    block.appendChild(controls);

    // Always-ask proposal awaiting a verdict.
    if (entry.pending !== undefined) {
      const prompt = document.createElement("div");
      prompt.className = "company-pending";
      const label = document.createElement("span");
      label.textContent = `Proposes ${entry.pending.defLabel} @ (${String(entry.pending.tileX)}, ${String(entry.pending.tileY)})`;
      const approve = document.createElement("button");
      approve.textContent = "Approve";
      approve.addEventListener("click", () => {
        deps.issueVerdict({ companyId: entry.companyId, approve: true });
      });
      const reject = document.createElement("button");
      reject.textContent = "Reject";
      reject.addEventListener("click", () => {
        deps.issueVerdict({ companyId: entry.companyId, approve: false });
      });
      prompt.append(label, approve, reject);
      block.appendChild(prompt);
    }

    for (const branch of entry.branches) {
      const line = document.createElement("div");
      line.className = "company-branch";
      line.textContent =
        branch.foremanLabel !== undefined
          ? `${branch.label} — ${branch.foremanLabel}`
          : `${branch.label} — no foreman`;
      const seize = document.createElement("button");
      seize.className = "company-seize";
      seize.textContent = "Seize";
      seize.title = "Take this branch back under direct control";
      seize.addEventListener("click", () => {
        deps.issueSeize({
          companyId: entry.companyId,
          branchId: branch.buildingEid,
        });
      });
      line.appendChild(seize);
      block.appendChild(line);
    }

    if (entry.logTail.length > 0) {
      const logHeading = document.createElement("div");
      logHeading.className = "company-log-heading";
      logHeading.textContent = "Expansion log (newest first)";
      block.appendChild(logHeading);
      for (const logEntry of entry.logTail) {
        const line = document.createElement("div");
        line.className = "company-log-entry";
        line.textContent = `t${String(logEntry.tick)} ${logEntry.text}`;
        block.appendChild(line);
      }
    }

    if (entry.ledgerTail.length > 0) {
      const ledgerHeading = document.createElement("div");
      ledgerHeading.className = "company-ledger-heading";
      ledgerHeading.textContent = "Ledger (newest first)";
      block.appendChild(ledgerHeading);
      for (const ledgerEntry of entry.ledgerTail) {
        const line = document.createElement("div");
        line.className = "company-ledger-entry";
        line.textContent = `t${String(ledgerEntry.tick)} +${ledgerEntry.credits} cr`;
        block.appendChild(line);
      }
    }
    return block;
  };

  const buildCharterForm = (offer: CompanyPanelCharterOffer): HTMLElement => {
    const form = document.createElement("div");
    form.className = "company-charter";
    const label = document.createElement("div");
    label.className = "company-charter-label";
    label.textContent = `Charter from selection (${offer.seedLabels.join(", ")})`;
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Company name";
    nameInput.maxLength = 24;
    const focusSelect = document.createElement("select");
    for (const slug of offer.focusSlugs) {
      const option = document.createElement("option");
      option.value = String(offer.focusSlugs.indexOf(slug));
      option.textContent = slug;
      focusSelect.appendChild(option);
    }
    const charterButton = document.createElement("button");
    charterButton.textContent = "Charter";
    charterButton.addEventListener("click", () => {
      const seeds = deps.selectedSeedBuildingIds();
      if (seeds.length === 0 || nameInput.value.trim().length === 0) return;
      deps.issueCharter({
        name: nameInput.value,
        focusDomain: Number(focusSelect.value),
        seedBuildingIds: [...seeds],
      });
    });
    form.append(label, nameInput, focusSelect, charterButton);
    return form;
  };

  return {
    refresh(): void {
      const data = deps.getData();
      const hasContent =
        data !== undefined &&
        (data.companies.length > 0 || data.charterOffer !== undefined);
      if (!hasContent || !data) {
        if (lastKey !== "") {
          lastKey = "";
          panel.style.display = "none";
        }
        return;
      }
      const key = JSON.stringify(data);
      if (key === lastKey) return;
      lastKey = key;
      panel.style.display = "block";
      while (panel.firstChild) panel.firstChild.remove();
      panel.append(titleEl, bodyEl);
      bodyEl.textContent = "";
      for (const entry of data.companies) {
        bodyEl.appendChild(buildCompanyBlock(entry));
      }
      if (
        data.charterOffer !== undefined &&
        data.charterOffer.seedLabels.length > 0
      ) {
        bodyEl.appendChild(buildCharterForm(data.charterOffer));
      }
    },
  };
}

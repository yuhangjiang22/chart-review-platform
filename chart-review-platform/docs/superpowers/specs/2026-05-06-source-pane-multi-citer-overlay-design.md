# Source-pane multi-citer overlay + compact agent strip

**Date:** 2026-05-06
**Status:** Proposed; awaiting sign-off
**Predecessor:** `2026-05-06-reviewer-evidence-citation-design.md` (the citation surface this restructures)

---

## Problem

The reviewer's actual workflow on a criterion looks like:

1. Glance at agent answers (left panel).
2. Switch to the source pane (right panel) to read chart material.
3. Cite evidence to their own annotation while there.
4. Cross-check against what agents cited.

Today's UI forces step 4 into a modal toggle: clicking an agent column filters the source pane to that agent's citations, hiding everyone else's. Switching between "see Agent 1", "see Agent 2", "see mine" requires three separate clicks far from where the reviewer is working. The user calls this "messy" and "annoying."

Two structural causes:

- **The source pane has a single citer-view at a time.** It renders highlights from `selectedAssessment.evidence` only, where `selectedAssessment` swaps between agent drafts and the committed annotation based on `selectedAgentId`. Comparing requires modal switching.
- **The big dual-agent panes are doing little real work.** They show agent answer + rationale + evidence list, but the reviewer reads evidence in the source pane (where the chart text actually is), not in the agent pane's evidence list. The pane consumes ~30 % of vertical space for a glance-once function.

## Goal

The reviewer should be able to:

- See **everyone's citations** (their own + each agent's) in the source pane simultaneously, color/marker-coded.
- Cite freely without changing modes — clicking `+` always adds to **their** annotation, regardless of "active" agent.
- Soft-focus a single citer when they want isolation, without it locking the rest of the UI into that mode.
- Recover the screen room currently spent on full-size agent panes by collapsing them into a compact strip with on-demand rationale expansion.

## Non-goals

- Changing the FieldAssessment schema or the actions endpoint.
- Per-citer evidence write paths (e.g. "edit Agent 2's evidence" — agents stay read-only).
- Changing the dual-agent comparison logic (auto role classification, derived adjudication).
- Reworking the form (Step 2 Answer/Rationale, Step 3 Evidence/Comment/Submit).

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Compact agent strip (replaces dual-agent panes)                  │
│   Agent 1: false  ▸ rationale  ·  Agent 2: no  ▸ rationale       │
│   (click name = soft-focus that agent's color in source pane)    │
│   (click ▸ = expand rationale + evidence list inline)            │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ Form (unchanged):  Step 2 Answer/Rationale, Step 3 Cite/Submit   │
└──────────────────────────────────────────────────────────────────┘
                                          ▲ data flow ▲
                                  evidence + drafts + commit
                                          ▼
┌──────────────────────────────────────────────────────────────────┐
│ Source pane (Notes / Structured / Timeline)                      │
│                                                                  │
│   Color key (always visible):                                    │
│     ● You    ── solid underline / oxblood chip                   │
│     ● Agent 1 ── solid ochre underline / ochre chip              │
│     ● Agent 2 ── dashed ochre underline / ochre chip with "2"    │
│                                                                  │
│   Notes:        each cited span carries citer underlines, stacked│
│                 when multiple citers share the same offsets.     │
│   Structured:   each row carries a row of citer chips on right.  │
│   Timeline:     same chips, same semantics.                      │
│                                                                  │
│   Soft-focus (optional): when an agent is "active", that         │
│   citer's color stays full opacity; others dim to ~30 %.         │
└──────────────────────────────────────────────────────────────────┘
```

The **multi-citer dataset** — a per-citer evidence map for the active criterion — is computed once in `PatientReview` and passed down. Both the source pane and the compact agent strip read from it.

### Citer identity

```ts
type Citer =
  | { kind: "you" }
  | { kind: "agent"; agent_id: string; slot: 1 | 2; label: "Agent 1" | "Agent 2" }
  | { kind: "derived" };
```

Slot is the deterministic index from `draftsForActive` (the same index the agent strip uses), so colors stay stable across renders.

### Color tokens

- **You**: `hsl(var(--oxblood))` — already the reviewer color today.
- **Agent 1**: `hsl(var(--ochre))` — solid stroke / solid chip.
- **Agent 2**: `hsl(var(--ochre))` — **dashed** stroke / chip with `"2"` numeral.
  - Two agents share the ochre family rather than introducing a new color. Numeral and stroke pattern carry the differentiation. Avoids palette inflation; matches existing "agent" pill semantics.
- **Derived**: `hsl(var(--sage))` — chip-only (derived assessments don't cite note spans).

### Soft-focus

Replaces today's "click agent column → filter source pane" hard mode. New behavior:

- Default: all citer layers visible at full opacity.
- Click an agent name in the compact strip → set `softFocusCiter`. That citer's marks stay 100 %; others dim to 30 %.
- Click the same agent name again, or click "Show all" → clear `softFocusCiter`.
- The form's edit semantics never change. `+ Cite` still writes to the human annotation.
- `selectedAgentId` (used by `effectiveAssessment` and `sourceLabel` today) is replaced by `softFocusCiter` for source-pane purposes; the existing source-label affordance stays accurate by reading from the new state.

---

## Components

### 1. `PatientReview.tsx` — multi-citer dataset

Build a single `citerEvidenceForActive` object once per render of the active criterion:

```ts
interface CiterEvidence {
  citer: Citer;
  evidence: Evidence[];
}

const citerEvidenceForActive: CiterEvidence[] = [
  // agent drafts (slot 1, slot 2 from draftsForActive)
  ...draftsForActive.slice(0, 2).map((d, i) => ({
    citer: { kind: "agent" as const, agent_id: d.agent_id, slot: (i + 1) as 1 | 2, label: `Agent ${i + 1}` as "Agent 1" | "Agent 2" },
    evidence: d.evidence ?? [],
  })),
  // human (committed if exists, else draftEvidence)
  {
    citer: { kind: "you" as const },
    evidence: assessmentByField.get(selected.field.id)?.evidence ?? draftEvidence,
  },
  // derived (only present for derived fields after recompute landed it)
  ...(committedDerivedAssessment ? [{ citer: { kind: "derived" as const }, evidence: committedDerivedAssessment.evidence ?? [] }] : []),
];
```

Pass this down to NoteViewer and the agent strip. It's the only new data plumbing.

Also add `softFocusCiter: Citer | null` state replacing `selectedAgentId`. The "click an agent → soft-focus" callback becomes simpler — no longer mutates `selectedAssessment`.

### 2. `CriterionCard.tsx` — compact agent strip

Replace the existing dual-agent grid with a one-line strip:

```
┌─────────────────────────────────────────────────────────────────┐
│ Agent 1: false  [▸ rationale]   ·   Agent 2: no  [▸ rationale]  │
└─────────────────────────────────────────────────────────────────┘
```

- Each agent's name is a clickable affordance that toggles `softFocusCiter`.
- The `▸` chevron toggles a per-agent `expanded` boolean (component-local state, two slots). Expanded content renders inline below that agent's strip cell, pushing the form down — same vertical-layout flow as everything else, no popovers. Independent per agent: Agent 1 expanded doesn't expand Agent 2.
- Bulk "Copy from Agent 1" / "Copy from Agent 2" / "Start fresh" buttons stay where they are (Step 2). Removing the dual-agent panes doesn't move them.

When derived field: keep the existing read-only Computed panel as-is. Derived panels skip the agent strip.

### 3. `NoteViewer.tsx` — multi-citer Notes overlay

Today the `citedSpans: CiteSpan[]` is built from `selectedAssessment.evidence` filtered to the active note. Replace with a richer build:

```ts
interface CiteSpan {
  start: number;
  end: number;
  verbatimQuote: string;
  bad: boolean;
  citers: Citer[]; // NEW: who cited this exact span (deduped by offsets)
}
```

For each `CiterEvidence` in `citerEvidenceForActive`, walk its note evidence; if a span matches an existing CiteSpan's `(start, end)`, push the citer onto `citers`; else create a new CiteSpan. Bad-offset spans are still flagged.

Render each span with stacked underlines, one per citer:

```css
/* one underline per citer, stacked vertically below text */
border-bottom: 2px solid var(--oxblood);            /* you */
+ box-shadow: 0 4px 0 0 var(--ochre);               /* agent 1 */
+ box-shadow: 0 4px 0 0 var(--ochre), 0 6px 0 0 var(--ochre) dashed; /* agent 2 stacked */
```

(Implementation likely pseudo-elements rather than `box-shadow` to avoid the "dashed shadow" hack — see implementation plan for actual CSS.)

Hover any cited span → tooltip "Cited by: You, Agent 1" listing all citers.

When `softFocusCiter` is set, dim non-matching citers' underlines to 30 % opacity (other layers still legible, just quieter).

The existing **selection-driven cite chip** (`» Cite for <field_id>`) is unchanged — selecting text still prompts a chip; clicking still POSTs to `/find-quote-offsets` and adds to the human's annotation.

### 4. `StructuredTab.tsx` + `TimelineTab.tsx` — citer chips

Today each row knows whether it's `cited` (boolean — flat). Replace with a per-row citer list:

```ts
interface RowCiterInfo {
  citers: Citer[];
}
```

Computed from `citerEvidenceForActive` on the parent (NoteViewer) and passed in as a Map keyed by `<table>:<row_id>`.

Render: small chip row on the right edge of each table row. One chip per citer:

```
┌─────────────────────────────────────────────────────────┐
│ 2025-07-15  Essential hypertension  I10    [● ●² ●you]  │
└─────────────────────────────────────────────────────────┘
```

- `●` = Agent 1 (ochre solid)
- `●²` = Agent 2 (ochre with "2" numeral overlay)
- `●you` = You (oxblood, slightly larger)

Hover any chip → tooltip "Cited by: ...".

The existing "+ Cite" button on hover stays — same semantic ("add to your annotation"). After clicking, the row's chips update to include `●you`.

### 5. Source-pane header — color key + soft-focus indicator

A thin row at the top of the source pane:

```
● You · ● Agent 1 · ● Agent 2          [×] focus: Agent 2
```

- Always-visible legend on the left.
- When `softFocusCiter` is set, a clearable badge on the right shows what's focused.
- Click the legend dot → toggle that citer's visibility (a softer "show/hide" mode for power users; opt-in, not the default behavior).

This is also the affordance to clear `softFocusCiter` when the user is done.

---

## Data flow — citing a Structured row, end to end

1. Reviewer is on `icd_lung_cancer_present`. Source pane shows Structured tab. Three condition rows visible. The first row (I10) shows chips `[●² ]` — Agent 2 cited it; nobody else.
2. Reviewer clicks `+ Cite` on the I10 row.
3. `StructuredTab.onCite` callback fires → builds `OmopEvidence` → propagates up to PatientReview's `handleCiteEvidence` → appends to `draftEvidence` (deduped).
4. `citerEvidenceForActive` recomputes from new state. The "you" entry now has I10 in its evidence list.
5. NoteViewer re-renders: the `citersByRowKey` map now has `"conditions:510001": [agent_2, you]`.
6. The I10 row re-renders with chips `[●² ●you]`. Agreement is visible immediately, no modal switch needed.
7. Reviewer hits Submit. Existing `/actions` write path persists `evidence` to disk.

---

## Edge cases

- **No agents (manual-only flow).** `citerEvidenceForActive` collapses to just `{citer: you, evidence: ...}`. Compact strip is hidden (no agents to show). Source pane shows only oxblood marks. Visually quieter — desired.
- **One agent only.** Strip shows just Agent 1. Source pane shows agent 1 + you. No Agent 2 markers anywhere.
- **Both agents cite the same span.** Stacked underlines (ochre solid + ochre dashed). Hover tooltip lists both. No visual surprise.
- **You + both agents on the same span.** Three stacked underlines (oxblood + ochre solid + ochre dashed). Compact but readable on lung-cancer-phenotype scale (max 3 citers). Above 3, this design becomes brittle — see Open Questions.
- **Soft-focus + cite.** Reviewer soft-focuses Agent 2; clicks `+` on a row. The new `you` chip appears at full opacity (you're not the focused citer, but you're never dimmed). Other dimmed agents stay dimmed.
- **Derived assessment.** Derived fields render the existing Computed panel; agent strip is hidden. Source-pane chips include `derived` (sage) on the rows the formula's inputs pull from — visual hint that "this row contributes to the auto-derived value". Optional; can defer.
- **Soft-focus on click of agent already focused.** Toggle off — clears `softFocusCiter`. Same as click-elsewhere.
- **Selection-cite chip while soft-focused.** Chip behavior identical regardless of soft-focus. The chip is "cite for criterion X to your annotation" and is independent of view filters.

## Open questions

- **N > 2 agents (calibration with more reviewers).** The current rubric is 2-agent default. Calibration could theoretically run more. Above 3 visible citer layers per span, stacked underlines get cluttered. **Recommendation for v1**: cap at 2 agent slots + you + derived. If a calibration adds a 3rd agent, show only first two in source pane; surface the rest as a tooltip-only "+1 more" indicator. Revisit if real calibration runs hit this.
- **Color-blind accessibility.** Ochre (yellow-orange) + oxblood (red-purple) is distinguishable for most red-green color blindness, but mark patterns (solid / dashed / "you" numeric label) carry the differentiation independent of hue, so the design is robust. Verify with an a11y check during implementation.

---

## Testing

Unit (vitest):

- **CiteSpan builder**: given mixed agent + human evidence on the same offsets, returns one CiteSpan with 2 citers; on different offsets, returns two CiteSpans each with 1 citer.
- **citersByRowKey**: deduped by `<table>:<row_id>`, citers in stable order (slot 1, slot 2, you, derived).
- **Soft-focus**: setting `softFocusCiter = agent_2` doesn't change which citers are present in the data — only their rendered opacity.

Component (vitest + RTL):

- Notes tab renders an `<span data-citer-count="2">` for a span cited by both you and Agent 1.
- Structured row renders 2 chips when cited by Agent 1 and you; 0 chips when uncited.
- Compact agent strip renders one row per agent; clicking the name dispatches a soft-focus event.
- Soft-focus dimming applies a 0.3 opacity class to non-focused citer marks.

E2E (Playwright, env-gated):

- Cite a Structured row → verify `●you` chip appears alongside agent chips on the same row, all in the same view, no mode switch.

Reuse the existing `lung-cancer-phenotype` corpus + `patient_easy_neg_01` fixture.

---

## Rollout

Single PR. No backwards-compat shims — the source pane re-render is the user-visible change. The data flowing in/out of the action endpoints, faithfulness gate, and on-disk schema is untouched.

The replaced/removed pieces:

- The big dual-agent panes JSX in `CriterionCard.tsx` (replaced by the compact strip).
- `selectedAgentId` state in `PatientReview.tsx` (replaced by `softFocusCiter`); `effectiveAssessment` and `sourceLabel` derive from the new state, but their public surface (props passed to `NoteViewer`) is unchanged.
- The implicit "click agent → filter source pane" behavior (replaced by soft-focus).

Behind no feature flag — single PR, small enough to revert.

## Implementation sketch

Touch list (estimated):

- `app/client/src/PatientReview/CriterionCard.tsx` — replace dual-agent block with compact strip. Per-agent `expanded` state is two booleans on the existing component (no new abstraction). Reuses `EvidenceList` with the existing `citerLabel` prop for the expanded evidence list.
- `app/client/src/ui/PatientReview.tsx` — build `citerEvidenceForActive`, replace `selectedAgentId` with `softFocusCiter`, thread to NoteViewer.
- `app/client/src/NoteViewer.tsx` — extend CiteSpan with `citers`, build `citersByRowKey`, render multi-color underlines + chip rows, header legend.
- `app/client/src/StructuredTab.tsx` + `TimelineTab.tsx` — accept `citersByRowKey: Map`, render per-row chips. Keep existing `onCite` and `cited` for back-compat (cited becomes derived from citers).
- `app/client/src/CriterionPane/EvidenceList.tsx` — no change. (citerLabel still works for the agent-strip-expanded evidence list.)

No server changes.

## What this DOESN'T touch

- Agent draft generation, MCP tools, the action endpoint, the recompute-derived flow, the Confirm-derived semantic, the auto-advance on submit, the selection-cite chip in Notes, the find-quote-offsets HTTP route. All untouched.

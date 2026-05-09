# Reviewer evidence citation in the manual annotation form

**Date:** 2026-05-06
**Status:** Proposed; awaiting sign-off
**Predecessor:** `2026-05-05-annotation-first-pilot-ui-design.md` (specifies the annotation form whose evidence component this design implements)

---

## Problem

The annotation-first reviewer UI in `CriterionCard.tsx` already plumbs evidence end-to-end:

- `FormState.evidence: Evidence[]` lives in component state (`CriterionCard.tsx:33-40`).
- `Copy from Agent N` copies the agent's evidence into form state (`CriterionCard.tsx:42-49`).
- `submitForm` already sends `evidence` to the actions endpoint (`CriterionCard.tsx:96-110`).
- `PatientReview.tsx:369-381` posts `evidence` to `/api/reviews/:p/:t/actions`.
- The server faithfulness gate (`review-state.ts:454`) verifies note offsets at write time.

But the form **never renders `form.evidence`** and offers no UI to add or remove it. Three observable consequences:

1. `Start fresh` produces an evidence-less annotation. The faithfulness gate has nothing to check, and downstream κ / improvement signals lose the "what did the human point at" data.
2. `Copy from Agent N` is opaque — the reviewer cannot see, edit, or trim the evidence they're inheriting.
3. The right-side `Source` pane (Notes / Structured / Timeline) is read-only with respect to citation. There is no path from "I read the chart and noticed this quote" to "this quote is now attached to my answer."

This design adds the missing UI — surface the existing field, add citation-from-source, and reuse the existing offset-resolution and faithfulness machinery.

## Goal

A reviewer who clicks `Start fresh` (or edits a copied draft) can:

- See the evidence currently attached to their in-progress answer.
- Add a note quote by selecting text in the `Notes` tab.
- Add a structured row by clicking `+` next to a row in `Structured` or `Timeline`.
- Remove an evidence item.
- Type a quote as a fallback when selection isn't natural (e.g., wraps a page break).

No new server validation, no new state surface, no change to per-criterion or per-patient status semantics.

## Non-goals

- Changing what "validated" or "locked" means at the patient level.
- Modifying the agent's evidence-citing path (MCP `set_field_assessment` / `select_evidence` / `find_quote_offsets`).
- Touching `selected_evidence[]` (review-level pin pool — orthogonal feature).
- Adding evidence to anything other than `assessment.evidence[]`.
- Multi-span (non-contiguous) selection.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ PatientReview.tsx (parent)                                   │
│   owns: form.evidence: Evidence[] for the active criterion   │
│   passes: evidence + onAddEvidence + onRemoveEvidence        │
│           down to CriterionCard AND NoteViewer/Structured    │
└──────────────────────────────────────────────────────────────┘
       │                                       │
       ▼                                       ▼
┌─────────────────────────┐           ┌─────────────────────────┐
│ CriterionCard           │           │ NoteViewer + Structured │
│  EVIDENCE chip-row      │           │  on selection / + click │
│  (renders + remove +    │           │  → onAddEvidence(ev)    │
│   "+ Add" dropdown)     │           │                         │
└─────────────────────────┘           └─────────────────────────┘
       │                                       │
       └─────────► same form.evidence ◄────────┘
                       │
                       ▼ Submit
            POST /api/reviews/:p/:t/actions
                  { …, evidence }
                       │
                       ▼ (existing) faithfulness gate
            verifyFaithfulnessForSetAssessment
```

The new server surface is one thin endpoint:

```
POST /api/reviews/:p/find-quote-offsets
  body  { note_id, snippet }
  resp  { ok: true, note_id, span_offsets: [start, end], verbatim_quote }
        | { ok: false, error_code, message }
```

This wraps the existing `find_quote_offsets` MCP tool's logic so the reviewer UI shares the agent's offset-resolution path.

---

## Component changes

### 1. `CriterionCard.tsx` — surface `form.evidence`

Lift `evidence` out of local `FormState`. Replace the current `FormState` shape:

```ts
interface FormState {
  answer: string;
  rationale: string;
  comment: string;
  // evidence removed — moved to props
}

interface CriterionCardProps {
  …existing props…
  evidence: Evidence[];
  onEvidenceChange: (next: Evidence[]) => void;
}
```

`Copy from Agent N` now calls both `setForm({ …fromDraft })` and `onEvidenceChange(d.evidence ?? [])`. `Start fresh` calls `onEvidenceChange([])`. `submitForm` reads `evidence` from props.

Render an `EVIDENCE` block between `Rationale` and `Comment`:

- Reuse `EvidenceList` with `onRemove={(idx) => onEvidenceChange(without(idx))}`.
- Empty state: a dashed box with copy `Cite supporting evidence — select text in Notes, or click + on a Structured row.`
- Trailing `+ Add` dropdown with three options: `Cite from current selection` (enabled if a selection exists), `Type a quote…` (opens an inline editor), `Pick structured row…` (focuses Structured tab).
- "Cite from current selection" is the primary action — keyboard shortcut `c` when a selection is active (verify against `keyboard.tsx` at implementation time; pick a different unused key if `c` collides).

### 2. `PatientReview.tsx` — own evidence for the active criterion

Single piece of state for the active criterion's draft evidence. Same lifecycle as today's `key={selected.field.id}` remount of `CriterionCard`, which already resets `answer` / `rationale` / `comment`:

```ts
const [draftEvidence, setDraftEvidence] = useState<Evidence[]>([]);

useEffect(() => {
  setDraftEvidence(committed?.evidence ?? []);
}, [selected?.field.id, committed]);
```

Pass `evidence` and the setter down to both children:

```ts
<CriterionCard
  …
  evidence={draftEvidence}
  onEvidenceChange={setDraftEvidence}
/>

<NoteViewer
  …
  activeFieldId={selected?.field.id ?? null}
  onCiteSelection={(ev) => setDraftEvidence((prev) => dedupe([...prev, ev]))}
/>
```

The Structured tab's `+ cite` button calls the same `onCiteSelection`. Deduplication keys: `(source, note_id, span_offsets)` for note evidence, `(source, table, row_id)` for structured.

### 3. `NoteViewer.tsx` — selection-to-cite

Wrap the rendered note text with an `onMouseUp` (and matching `onKeyUp` for keyboard selection) that captures the current selection:

```ts
function captureSelection(): { snippet: string; rect: DOMRect } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const snippet = sel.toString();
  if (!snippet.trim()) return null;
  return { snippet, rect: range.getBoundingClientRect() };
}
```

When a non-empty selection lives inside the note body, render a floating action chip anchored to `rect`:

```
[ » Cite for icd_lung_cancer_present ]
```

Click → POST to `/api/reviews/:p/find-quote-offsets` with `{ note_id: activeNoteId, snippet }` → on `ok`, build a `NoteEvidence` object → call `onCiteSelection(ev)` → clear the selection. On error, surface the server's `message` in a small inline error.

The chip disappears on `selectionchange` (selection collapsed) or after a successful cite.

### 4. Structured / Timeline tab — `+` on each row

Add a `+ cite` button next to the existing `» CITED` ribbon on each row. The two are visually adjacent but mean different things — "CITED" is a *status badge* showing the row is in some assessment's evidence list; "+ cite" is the *action* to add the row to the in-progress form. Hovered row highlights both controls.

Click → build an `OmopEvidence` object from the row's `{ table, row_id, concept_id, concept_name, value, unit, evidence_date }` → call `onCiteSelection(ev)`.

No server round-trip needed — structured rows are already canonical.

### 5. New server endpoint — thin wrapper around `find_quote_offsets`

In `server/adapters/http/review-routes.ts`, add:

```ts
router.post("/api/reviews/:patient_id/find-quote-offsets", async (req, res) => {
  const { note_id, snippet } = req.body ?? {};
  // Validate inputs.
  // Read note via the same helper mcp-tools.ts:findQuoteOffsets uses.
  // Return { ok, note_id, span_offsets: [start, end], verbatim_quote } or
  // { ok: false, error_code: "note_not_found" | "snippet_not_found", message }.
});
```

Implementation extracts the body of `findQuoteOffsets` from `mcp-tools.ts:368-…` into a shared helper called from both the MCP tool and this HTTP route. Whitespace tolerance behavior is preserved.

---

## Data flow — selection-to-cite end to end

1. Reviewer selects text inside the rendered note in `NoteViewer`.
2. `onMouseUp` captures `{ snippet, rect }`; floating chip appears.
3. Reviewer clicks `» Cite for <field_id>`.
4. `NoteViewer` POSTs `{ note_id, snippet }` to `/api/reviews/:p/find-quote-offsets`.
5. Server returns `{ ok, span_offsets: [start, end], verbatim_quote }` (verbatim_quote is the canonical form from the note text — whitespace-normalized).
6. `NoteViewer` calls `onCiteSelection({ source: "note", note_id, span_offsets, verbatim_quote, evidence_date, doc_type })`.
7. `PatientReview` appends to `draftEvidenceByField[activeFieldId]`.
8. `CriterionCard` re-renders the `EVIDENCE` block with the new chip.
9. Reviewer eventually clicks `Submit`; the existing `/actions` POST sends `evidence` and the existing faithfulness gate verifies offsets at write time.

The faithfulness gate is the source of truth — `find-quote-offsets` is a UX optimization that lets the reviewer's offsets be right *before* submission, not a substitute for the gate.

---

## Edge cases

- **Selection wraps cited / failed / search highlight spans.** The selection's text content matches the underlying note text regardless of how it's broken into segments. `find_quote_offsets` handles whitespace normalization. No special handling.
- **Selection includes a span boundary that splits a word.** The user's `snippet` is what they highlighted; if it doesn't match the note text and whitespace tolerance can't recover, the server returns `snippet_not_found`. The chip surfaces the error inline.
- **Selection in a different note than the agent cited.** Each selection uses `activeNoteId` from `NoteViewer`, not the field's existing evidence. Nothing prevents citing across multiple notes; the evidence list grows.
- **Reviewer adds duplicate evidence.** Deduplicate by `(source, note_id, span_offsets)` for note evidence and `(source, table, row_id)` for structured. Silent no-op on duplicate.
- **Reviewer changes criterion mid-edit.** Same lifecycle as the rest of the form — `draftEvidence` resets on `selected.field.id` change to `committed?.evidence ?? []`, exactly like `answer` / `rationale` / `comment` reset today via the `CriterionCard` `key=` remount. Unsubmitted edits are not preserved across navigation. (Future improvement: lift the rest of the form too and persist all four together.)
- **`Copy from Agent N` after the reviewer manually added a quote.** Copy overwrites — same as the rest of the form. (Matches user expectation: "Copy" replaces, not "Merge".)
- **Locked review.** All add/remove controls hidden, matching how the form's other controls already gate on `isLocked`.

## Status implications

None. Per-criterion `Submit` continues to write `status: "approved"` (set in `PatientReview.tsx:379`). Patient-level `Mark validated` and `Lock` in the footer are unchanged.

---

## Testing

Unit (vitest):

- `CriterionCard`: renders `EVIDENCE` block when `evidence.length > 0`; calls `onEvidenceChange` with `evidence` removed at index `i` on `×`; `Copy from Agent N` calls `onEvidenceChange(d.evidence)`; `Start fresh` calls `onEvidenceChange([])`; `Submit` includes `evidence` in payload.
- `PatientReview`: `draftEvidence` resets to `committed?.evidence ?? []` when `selectedFieldId` changes; selecting a row in Structured or citing a snippet in Notes appends via `onCiteSelection` and dedupes correctly.
- `NoteViewer`: `onMouseUp` with empty selection is a no-op; with a selection, chip appears anchored to the right rect; click POSTs to `/find-quote-offsets`; `ok=false` shows error inline.
- Server: `/find-quote-offsets` returns `{ ok, span_offsets }` for an exact match; whitespace-normalized match; `snippet_not_found` for missing text; `note_not_found` for bad `note_id`.

E2E (Playwright):

- "Reviewer cites a quote from notes and submits" — single happy-path scenario covering selection → chip → submit → on-disk assessment has the cited evidence.
- "Reviewer adds a structured row, removes a copied agent quote, submits" — covers + cite from Structured + the × remove path.

Reuse the existing `lung-cancer-phenotype` corpus + reference rubric for both. No new fixture data.

---

## Rollout

Single PR. Behind no feature flag — the form gains visible UI; existing clients get the same submit semantics they already had. Backwards compatible: assessments submitted without evidence still work (just like today).

## Open questions

None requiring user input before implementation. Implementation-time decisions:

- Floating chip styling — match existing copilot-suggestion panel motif (oxblood border, sage CTA).
- Keyboard shortcut for cite-from-selection — `c` (chosen because the existing shortcut map uses `a` accept / `o` override / `f` flag and `c` is unused).
